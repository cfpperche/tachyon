/**
 * t-0fec1d — deferred review nits on the governed recovery mechanisms shipped in 0.56.75.
 *
 * Three promises, each of which was false before this suite existed:
 *   N1. The direct `reconcileBase` call and the reconcile-loop replay of the SAME approved repair
 *       write the same field scope. t-2dd637 §4 scopes the repair to `baseRef`; the direct path also
 *       refreshed the derived `currentHeadSha`, so a crash between intent and apply silently changed
 *       which fields the repair touched.
 *   N2. An APPROVED repair that turns out to be a stale no-op leaves a durable audit transition.
 *       Previously the loop advanced the sequence with an identity mutate and recorded nothing, so
 *       the only trace was the original intent — which reads as applied.
 *   N4. `abandonFreeDelivery` refuses a human/master/system caller with a message that names the
 *       actual precondition (the actor kind) rather than an approval-availability problem.
 *
 * The field-scope oracle is differential, not a hardcoded field list: it compares the two paths
 * against each other, so it stays honest if §4's scope is later widened deliberately on BOTH paths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryLeaseService,
  type DeliveryAgentLiveState,
  type DeliveryRecoveryApproval,
} from "../../src/delivery/leaseService.js";
import {
  buildSingleDeliveryReloadSnapshot,
  DeliveryProjectionService,
  listProjectionIntents,
} from "../../src/delivery/projectionService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { DeliveryActor, DeliveryCreateInput } from "../../src/delivery/types.js";
import { GitDeliveryStore } from "../../src/git-delivery/store.js";
import type { GitDelivery, GitDeliverySettings } from "../../src/git-delivery/types.js";
import type { GitExec, GitResult } from "../../src/worktree/WorktreeManager.js";

const now = "2026-07-19T12:00:00.000Z";
const human = { kind: "human" as const, name: "maintainer" };
const approver: DeliveryActor = { kind: "agent", name: "coordinator" };

/** The pinned spawn SHA that degraded into the projection base (t-2dd637 §1.3). */
const PINNED_BASE = "8787658ae1bc2ed11c3ee002f0bf2cb7bd3b4c08";
/** The live branch tip — a descendant of the pin, so containment is unsatisfiable while pinned. */
const TIP = "89d364180b4259a17dfe479e57dcf6f16a9e8ec1";
/**
 * The head recorded on the projection at open time, deliberately STALE relative to `TIP`. Without
 * this divergence a `currentHeadSha` refresh would be value-identical and the N1 oracle could not
 * observe the extra write at all.
 */
const OPEN_HEAD = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const TARGET_BRANCH = "main";

const settings: GitDeliverySettings = { prunePrincipals: ["orch"], integratePrincipals: ["orch"] };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function root(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function approvalBoundTo(actionDigest: string, requester: string): DeliveryRecoveryApproval {
  return {
    decision: "approved",
    requester,
    actionDigest,
    payloadHash: "payload-hash-a67f21b",
    resolvedAt: now,
    resolvedBy: "maintainer",
  };
}

// ---------------------------------------------------------------------------
// Scripted git worlds
// ---------------------------------------------------------------------------

function ok(stdout = ""): GitResult { return { code: 0, stdout, stderr: "" }; }
function no(stderr = ""): GitResult { return { code: 1, stdout: "", stderr }; }

type GitScript = Record<string, GitResult | ((args: string[]) => GitResult)>;

/** The defect class: the stored base is a real commit but not a branch, and the tip escaped it. */
function defectiveWorld(branchRef: string): GitScript {
  return {
    [`show-ref --verify --quiet refs/heads/${branchRef}`]: ok(),
    [`rev-parse ${branchRef}`]: ok(`${TIP}\n`),
    "status --porcelain=v1 --untracked-files=all": ok(""),
    [`merge-base --is-ancestor ${TIP} ${PINNED_BASE}`]: no(),
    [`cherry ${PINNED_BASE} ${TIP}`]: no(),
    [`show-ref --verify --quiet refs/heads/${PINNED_BASE}`]: no(),
    [`rev-parse --verify --quiet ${PINNED_BASE}^{commit}`]: ok(`${PINNED_BASE}\n`),
    [`show-ref --verify --quiet refs/heads/${TARGET_BRANCH}`]: ok(),
    [`merge-base --is-ancestor ${PINNED_BASE} ${TARGET_BRANCH}`]: ok(),
    [`merge-base --is-ancestor ${TIP} ${TARGET_BRANCH}`]: ok(),
  };
}

/**
 * The same record after the world moved on: the stored base now exists as a real branch and the tip
 * is contained in it. A repair intent minted against `defectiveWorld` is now stale — the defect-class
 * predicates no longer hold, and the ordinary integrate can close the record with the base untouched.
 */
function healedWorld(branchRef: string): GitScript {
  return {
    ...defectiveWorld(branchRef),
    [`show-ref --verify --quiet refs/heads/${PINNED_BASE}`]: ok(),
    [`merge-base --is-ancestor ${TIP} ${PINNED_BASE}`]: ok(),
  };
}

/** A git exec whose scripted world can be swapped between calls. */
function mutableGit(initial: GitScript): { git: GitExec; set: (script: GitScript) => void } {
  let script = initial;
  return {
    set: (next) => { script = next; },
    git: async (args) => {
      const hit = script[args.join(" ")];
      if (!hit) return no(`unscripted git call: ${args.join(" ")}`);
      return typeof hit === "function" ? hit(args) : hit;
    },
  };
}

function locks() {
  const map = new Map<string, Promise<unknown>>();
  return async <T>(p: string, fn: () => Promise<T>): Promise<T> => {
    const key = path.resolve(p);
    const prior = map.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    map.set(key, prior.then(() => gate));
    await prior.catch(() => undefined);
    try { return await fn(); } finally { release(); }
  };
}

/**
 * Wraps the real projection store so a single canonical apply can be made to crash. This is how the
 * replay path is reached honestly: the intent is appended durably, the projection apply dies, and
 * `reconcile()` is then the only thing that can finish the repair — exactly the crash window the
 * reconcile loop exists to close.
 */
function applyGate(store: GitDeliveryStore, fail: { on: boolean }): GitDeliveryStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "applyCanonicalIntent") {
        return async (input: Parameters<GitDeliveryStore["applyCanonicalIntent"]>[0]) => {
          if (fail.on) throw new Error("scripted crash between intent append and projection apply");
          return target.applyCanonicalIntent(input);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// Projection fixture
// ---------------------------------------------------------------------------

async function projectionFixture(id: string, world: GitScript = defectiveWorld("tachyon/d")) {
  const workspace = root("tachyon-reconcile-audit-");
  const wt = path.join(workspace, "wt");
  fs.mkdirSync(wt);
  const branchRef = "tachyon/d";
  const deliveries = new DeliveryStore(workspace, { now: () => now });
  const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
  const fail = { on: false };
  const scripted = mutableGit(world);

  await deliveries.create({
    id,
    workspaceId: "ws",
    createdBy: approver,
    contract: { baseSha: PINNED_BASE, behaviorTest: "behavior", owns: ["src"], taskRef: branchRef },
    lease: { state: "free", changedAt: now },
    segments: [{
      id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: approver,
      ownsSubset: ["src"], grantedHeadSha: PINNED_BASE, grantedAt: now,
      releasedAt: now, releasedHeadSha: TIP, outcome: "completed",
    }],
    events: [{ id: "event-0", at: now, type: "created", by: approver }],
  } satisfies DeliveryCreateInput);

  const svc = new DeliveryProjectionService({
    deliveries,
    gitDeliveries: applyGate(gitDeliveries, fail),
    workspaceRoot: workspace,
    workspaceId: "ws",
    git: scripted.git,
    liveness: async () => "not_live",
    worktreeOccupancy: async () => undefined,
    withWorktreeLock: locks(),
    settings: () => settings,
    loadReloadSnapshot: async (deliveryId) => {
      const d = await deliveries.get(deliveryId);
      if (!d) throw new Error("missing");
      const p = d.gitDeliveryId ? await gitDeliveries.get(d.gitDeliveryId) : undefined;
      return buildSingleDeliveryReloadSnapshot({ delivery: d, projection: p });
    },
    targetBranch: () => TARGET_BRANCH,
    resolveBaseRepairApproval: vi.fn(async (_id: string, _actor: DeliveryActor, digest: string) => (
      approvalBoundTo(digest, approver.name!)
    )),
    now: () => now,
  });

  const opened = await svc.openCanonical({
    deliveryId: id,
    agent: "worker",
    branchRef,
    worktreePath: wt,
    tachyonCreatedBranch: false,
    baseRef: PINNED_BASE,
    // Deliberately stale: the live tip resolves to TIP, so a derived-head refresh is observable.
    currentHeadSha: OPEN_HEAD,
    actor: approver,
    operationId: `${id}-open`,
  });

  return { workspace, deliveries, gitDeliveries, svc, opened, fail, git: scripted, branchRef };
}

function reconcileBaseInput(id: string, gitDeliveryId: string, version: number) {
  return {
    deliveryId: id,
    gitDeliveryId,
    expectedGitVersion: version,
    proposedBaseRef: TARGET_BRANCH,
    approvalId: "a-base-repair",
    actor: human,
    caller: human,
    operationId: `${id}-repair`,
  };
}

/** Every key whose value differs — the durable field scope a code path actually wrote. */
function changedFields(before: GitDelivery, after: GitDelivery): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => !isDeepStrictEqual(before[k], after[k])).sort();
}

// ===========================================================================

describe("reconcile_base writes one field scope on both paths (t-0fec1d N1)", () => {
  it("mutates the same durable fields whether applied directly or replayed by reconcile()", async () => {
    // Path A — the direct call applies its own intent.
    const direct = await projectionFixture("d-direct");
    const beforeDirect = (await direct.gitDeliveries.get(direct.opened.projection.id))!;
    await direct.svc.reconcileBase(
      reconcileBaseInput("d-direct", direct.opened.projection.id, direct.opened.projection.version),
    );
    const afterDirect = (await direct.gitDeliveries.get(direct.opened.projection.id))!;

    // Path B — the apply crashes after the intent is durable, so reconcile() finishes the repair.
    const replay = await projectionFixture("d-replay");
    replay.fail.on = true;
    await expect(replay.svc.reconcileBase(
      reconcileBaseInput("d-replay", replay.opened.projection.id, replay.opened.projection.version),
    )).rejects.toThrow(/scripted crash/);
    replay.fail.on = false;

    const pending = (await replay.gitDeliveries.get(replay.opened.projection.id))!;
    // The crash window is real: the intent is durable but the projection has not applied it.
    expect(listProjectionIntents((await replay.deliveries.get("d-replay"))!)
      .filter((i) => i.action === "reconcile_base")).toHaveLength(1);
    expect(pending.baseRef).toBe(PINNED_BASE);

    const beforeReplay = pending;
    await replay.svc.reconcile("d-replay");
    const afterReplay = (await replay.gitDeliveries.get(replay.opened.projection.id))!;
    // The repair intent — not merely some earlier intent — is what the loop applied.
    expect(afterReplay.lastAppliedOperationId).toBe("d-replay-repair");

    // Both paths repaired the base...
    expect(afterDirect.baseRef).toBe(TARGET_BRANCH);
    expect(afterReplay.baseRef).toBe(TARGET_BRANCH);

    // ...and — the oracle — touched exactly the same set of durable fields doing it.
    const directScope = changedFields(beforeDirect, afterDirect);
    const replayScope = changedFields(beforeReplay, afterReplay);
    expect(directScope).toEqual(replayScope);

    // §4 scopes the repair to `baseRef`. The derived head is re-read live on every use and must not
    // be rewritten by a base repair on either path — that divergence is exactly the N1 defect.
    expect(directScope).toContain("baseRef");
    expect(directScope).not.toContain("currentHeadSha");
    expect(afterDirect.currentHeadSha).toBe(OPEN_HEAD);
    expect(afterReplay.currentHeadSha).toBe(OPEN_HEAD);
  });
});

describe("a stale approved reconcile_base leaves a durable audit trace (t-0fec1d N2)", () => {
  it("appends a no-op audit transition, advances the sequence, and wedges nothing", async () => {
    const f = await projectionFixture("d-stale");
    const gitDeliveryId = f.opened.projection.id;

    // Mint an approved repair intent against the defective world, then crash before it applies.
    f.fail.on = true;
    await expect(f.svc.reconcileBase(
      reconcileBaseInput("d-stale", gitDeliveryId, f.opened.projection.version),
    )).rejects.toThrow(/scripted crash/);
    f.fail.on = false;

    const intent = listProjectionIntents((await f.deliveries.get("d-stale"))!)
      .find((i) => i.action === "reconcile_base")!;
    expect(intent).toBeDefined();

    // The world heals by other means before the loop gets there: the repair is now a stale no-op.
    f.git.set(healedWorld(f.branchRef));
    const before = (await f.gitDeliveries.get(gitDeliveryId))!;
    await f.svc.reconcile("d-stale");
    const after = (await f.gitDeliveries.get(gitDeliveryId))!;
    expect(after.lastAppliedOperationId).toBe(intent.operationId);

    // The repair correctly did nothing to the base — the defect class no longer holds.
    expect(after.baseRef).toBe(PINNED_BASE);

    // ...but it is no longer invisible. The approved-yet-inert repair has its own transition.
    expect(after.transitions.length).toBe(before.transitions.length + 1);
    const audit = after.transitions.at(-1)!;
    expect(audit.reason).toMatch(/no-op/);
    expect(audit.reason).toContain(intent.operationId);
    expect(audit.reason).toMatch(/no longer the repairable defect class/);
    expect(audit.by).toMatchObject({ name: human.name });
    // A no-op is not a phase change.
    expect(audit.to).toBe(after.phase);
    expect(audit.from).toBe(before.phase);

    // The not-wedging property is preserved: the sequence advanced, so a later intent is not stuck
    // behind the stale one. The ordinary integrate closes the record on its own unweakened oracle.
    expect(after.lastAppliedProjectionSequence).toBe(intent.projectionSequence);
    const integrated = await f.svc.integrate({
      deliveryId: "d-stale",
      gitDeliveryId,
      expectedGitVersion: after.version,
      expectedHeadSha: TIP,
      actor: human,
      caller: human,
      operationId: "d-stale-integrate",
    });
    expect(integrated.projection.phase).toBe("integrated");
  });
});

// ===========================================================================

describe("abandonFreeDelivery names the precondition it actually refused on (t-0fec1d N4)", () => {
  async function leaseFixture() {
    const workspace = root("tachyon-free-abandon-msg-");
    const worktree = path.join(workspace, "wt");
    fs.mkdirSync(worktree);
    const store = new DeliveryStore(workspace, { now: () => now });
    await store.create({
      id: "d-free",
      workspaceId: "ws",
      createdBy: approver,
      contract: { baseSha: PINNED_BASE, behaviorTest: "behavior", owns: ["src"], taskRef: "tachyon/d" },
      lease: { state: "free", changedAt: now },
      segments: [{
        id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: approver,
        ownsSubset: ["src"], grantedHeadSha: PINNED_BASE, grantedAt: now,
        releasedAt: now, releasedHeadSha: TIP, outcome: "completed",
      }],
      events: [{ id: "event-0", at: now, type: "created", by: approver }],
    } satisfies DeliveryCreateInput);

    let events = 0;
    const lease = new DeliveryLeaseService({
      store,
      canonicalWorktreeFor: () => worktree,
      readHead: () => TIP,
      inspectWorktree: () => ({ headSha: TIP, clean: true }),
      isAncestor: () => true,
      withWorktreeLock: async (_p, fn) => fn(),
      processObserver: { observe: async () => ({ state: "alive" }) },
      recoveryPrincipals: ["coordinator", "worker"],
      agentLiveness: async (): Promise<DeliveryAgentLiveState> => "not_live",
      worktreeOccupancy: async () => undefined,
      resolveRecoveryApproval: async (_id, _actor, digest) => approvalBoundTo(digest, approver.name!),
      now: () => now,
      nonce: () => "nonce",
      segmentId: () => "seg-1",
      eventId: () => `event-${++events}`,
    });
    return { lease, worktree };
  }

  const attempt = async (actor: DeliveryActor): Promise<string> => {
    const { lease, worktree } = await leaseFixture();
    try {
      await lease.abandonFreeDelivery({
        deliveryId: "d-free",
        canonicalWorktree: worktree,
        actor,
        operationId: "op-free-abandon",
        expectedHeadSha: TIP,
        approvalId: "a-67f21b",
      });
      return "resolved";
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  };

  it("tells a human caller that the actor kind is the blocker, not the approval capability", async () => {
    const message = await attempt(human);

    // Every approval dependency in this fixture IS available and bound — so a message about the
    // approval being "unavailable or unbound" would send the reader after a phantom misconfiguration.
    expect(message).not.toMatch(/unavailable or unbound/);
    expect(message).toMatch(/agent/);
    expect(message).toContain("human");
  });

  it("refuses master and system callers for the same named reason", async () => {
    for (const kind of ["master", "system"] as const) {
      const message = await attempt({ kind, name: kind });
      expect(message).not.toMatch(/unavailable or unbound/);
      expect(message).toContain(kind);
    }
  });

  it("still admits a bound agent caller — the refusal set is unchanged, only the wording", async () => {
    const { lease, worktree } = await leaseFixture();
    const delivery = await lease.abandonFreeDelivery({
      deliveryId: "d-free",
      canonicalWorktree: worktree,
      actor: approver,
      operationId: "op-free-abandon",
      expectedHeadSha: TIP,
      approvalId: "a-67f21b",
    });
    expect(delivery.lease.state).toBe("abandoned");
  });
});
