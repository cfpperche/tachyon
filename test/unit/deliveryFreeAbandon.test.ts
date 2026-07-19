/**
 * t-9e57e8 + t-2dd637 §4/§6.2 — the two governed recovery mechanisms for a superseded delivery.
 *
 * Two independent exits for a record whose projection cannot integrate:
 *   1. free → abandoned  (the record is unsalvageable: dispose of it)
 *   2. reconcile_base    (the record is good: repair the defect-class base, then integrate normally)
 *
 * The refusal oracles vary exactly one factor at a time from a passing fixture. Every action digest
 * is spelled out here rather than imported, so the tests pin the digest *contract* instead of
 * echoing back whatever the implementation happens to compute.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryLeaseService,
  type DeliveryAgentLiveState,
  type DeliveryRecoveryApproval,
  type DeliveryWorktreeOccupant,
} from "../../src/delivery/leaseService.js";
import {
  buildSingleDeliveryReloadSnapshot,
  DeliveryProjectionService,
  listProjectionIntents,
} from "../../src/delivery/projectionService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { DeliveryActor, DeliveryCreateInput } from "../../src/delivery/types.js";
import { GitDeliveryStore } from "../../src/git-delivery/store.js";
import type { GitDeliverySettings } from "../../src/git-delivery/types.js";
import type { GitExec, GitResult } from "../../src/worktree/WorktreeManager.js";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";

const now = "2026-07-19T12:00:00.000Z";
const human = { kind: "human" as const, name: "maintainer" };
/** Authorized recovery caller; deliberately NOT the former holder. */
const approver: DeliveryActor = { kind: "agent", name: "coordinator" };
/** The former lease holder. Authorized to recover in general, but never its own delivery. */
const formerHolder: DeliveryActor = { kind: "agent", name: "worker" };

/** The pinned spawn SHA that degraded into the projection base (t-2dd637 §1.3). */
const PINNED_BASE = "8787658ae1bc2ed11c3ee002f0bf2cb7bd3b4c08";
/** The live branch tip — a descendant of the pin, so containment is unsatisfiable while pinned. */
const TIP = "89d364180b4259a17dfe479e57dcf6f16a9e8ec1";
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

// ---------------------------------------------------------------------------
// Fixed digest oracles (independently specified, not imported from the service)
// ---------------------------------------------------------------------------

function freeAbandonDigest(input: { deliveryId: string; expectedHeadSha: string; operationId: string; actor: DeliveryActor }): string {
  return createHash("sha256").update(JSON.stringify({
    deliveryId: input.deliveryId,
    expectedHeadSha: input.expectedHeadSha,
    inventory: { headSha: input.expectedHeadSha, dirtyPaths: [], uniqueCommits: [] },
    intent: { action: "abandon-free", operationId: input.operationId, actor: input.actor },
  })).digest("hex");
}

function baseRepairDigest(input: {
  gitDeliveryId: string; currentBaseRef: string; proposedBaseRef: string; currentHeadSha: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    action: "reconcile_base",
    gitDeliveryId: input.gitDeliveryId,
    currentBaseRef: input.currentBaseRef,
    proposedBaseRef: input.proposedBaseRef,
    currentHeadSha: input.currentHeadSha,
  })).digest("hex");
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
// Lease-service harness (in-memory store + fake clock + explicit actors)
// ---------------------------------------------------------------------------

interface FreeFixtureOptions {
  liveState?: DeliveryAgentLiveState | (() => DeliveryAgentLiveState);
  occupant?: DeliveryWorktreeOccupant | (() => DeliveryWorktreeOccupant | undefined);
  clean?: boolean;
  headSha?: string;
  approval?: DeliveryRecoveryApproval | ((digest: string) => DeliveryRecoveryApproval);
  omitApprovalResolver?: boolean;
  omitLiveness?: boolean;
  omitOccupancy?: boolean;
  openTail?: boolean;
  held?: boolean;
}

async function freeFixture(options: FreeFixtureOptions = {}) {
  const workspace = root("tachyon-free-abandon-");
  const worktree = path.join(workspace, "wt");
  fs.mkdirSync(worktree);
  const store = new DeliveryStore(workspace, { now: () => now });
  const tail = {
    id: "seg-0", index: 0, role: "implementer" as const, executionAgent: "worker",
    grantedBy: approver, ownsSubset: ["src"], grantedHeadSha: PINNED_BASE, grantedAt: now,
    ...(options.openTail ? {} : { releasedAt: now, releasedHeadSha: TIP, outcome: "completed" as const }),
  };
  const input: DeliveryCreateInput = {
    id: "d-free",
    workspaceId: "ws",
    createdBy: approver,
    contract: { baseSha: PINNED_BASE, behaviorTest: "behavior", owns: ["src"], taskRef: "tachyon/d" },
    lease: options.held
      ? {
        state: "held",
        holder: { segmentId: "seg-0", executionAgent: "worker", process: { pid: 7, processStart: "10", bootId: "boot" }, executionNonce: "exec-0" },
        expectedHeadSha: TIP,
        changedAt: now,
      }
      : { state: "free", changedAt: now },
    segments: [tail],
    events: [{ id: "event-0", at: now, type: "created", by: approver }],
  };
  const delivery = await store.create(input);

  const liveness = vi.fn(async (): Promise<DeliveryAgentLiveState> => (
    typeof options.liveState === "function" ? options.liveState() : options.liveState ?? "not_live"
  ));
  const occupancy = vi.fn(async (): Promise<DeliveryWorktreeOccupant | undefined> => (
    typeof options.occupant === "function" ? options.occupant() : options.occupant
  ));
  const resolveApproval = vi.fn(async (_id: string, _actor: DeliveryActor, digest: string) => (
    typeof options.approval === "function"
      ? options.approval(digest)
      : options.approval ?? approvalBoundTo(digest, approver.name!)
  ));

  let events = 0;
  const lease = new DeliveryLeaseService({
    store,
    canonicalWorktreeFor: () => worktree,
    readHead: () => options.headSha ?? TIP,
    inspectWorktree: () => ({ headSha: options.headSha ?? TIP, clean: options.clean ?? true }),
    isAncestor: () => true,
    withWorktreeLock: async (_p, fn) => fn(),
    processObserver: { observe: async () => ({ state: "alive" }) },
    recoveryPrincipals: ["coordinator", "worker"],
    ...(options.omitLiveness ? {} : { agentLiveness: liveness }),
    ...(options.omitOccupancy ? {} : { worktreeOccupancy: occupancy }),
    ...(options.omitApprovalResolver ? {} : { resolveRecoveryApproval: resolveApproval }),
    now: () => now,
    nonce: () => "nonce",
    segmentId: () => "seg-1",
    eventId: () => `event-${++events}`,
  });

  return { workspace, worktree, store, lease, delivery, liveness, occupancy, resolveApproval };
}

function abandonFreeInput(worktree: string, overrides: Partial<{ operationId: string; actor: DeliveryActor; expectedHeadSha: string }> = {}) {
  return {
    deliveryId: "d-free",
    canonicalWorktree: worktree,
    actor: overrides.actor ?? approver,
    operationId: overrides.operationId ?? "op-free-abandon",
    expectedHeadSha: overrides.expectedHeadSha ?? TIP,
    approvalId: "a-67f21b",
  };
}

// ---------------------------------------------------------------------------
// Projection-service harness (real stores + scripted git)
// ---------------------------------------------------------------------------

function ok(stdout = ""): GitResult { return { code: 0, stdout, stderr: "" }; }
function no(stderr = ""): GitResult { return { code: 1, stdout: "", stderr }; }

function gitScript(script: Record<string, GitResult | ((args: string[]) => GitResult)>): GitExec {
  return async (args) => {
    const hit = script[args.join(" ")] ?? script["*"];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected git: ${args.join(" ")}` };
    return typeof hit === "function" ? hit(args) : hit;
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
 * Git script for the broken record: the branch tip is a *descendant* of the pinned base, so
 * containment against the pin refuses forever, while containment against the target branch holds.
 */
function repairGitScript(branchRef: string, overrides: Record<string, GitResult | ((args: string[]) => GitResult)> = {}): GitExec {
  return gitScript({
    [`show-ref --verify --quiet refs/heads/${branchRef}`]: ok(),
    [`rev-parse ${branchRef}`]: ok(`${TIP}\n`),
    "status --porcelain=v1 --untracked-files=all": ok(""),
    // The defect: tip is not contained in the pinned SHA base, and never will be.
    [`merge-base --is-ancestor ${TIP} ${PINNED_BASE}`]: no(),
    [`cherry ${PINNED_BASE} ${TIP}`]: no(),
    // The pinned base is not a branch, but it is a real commit, and it IS an ancestor of main.
    [`show-ref --verify --quiet refs/heads/${PINNED_BASE}`]: no(),
    [`rev-parse --verify --quiet ${PINNED_BASE}^{commit}`]: ok(`${PINNED_BASE}\n`),
    [`show-ref --verify --quiet refs/heads/${TARGET_BRANCH}`]: ok(),
    [`merge-base --is-ancestor ${PINNED_BASE} ${TARGET_BRANCH}`]: ok(),
    // After the repair, containment against the target branch succeeds.
    [`merge-base --is-ancestor ${TIP} ${TARGET_BRANCH}`]: ok(),
    ...overrides,
    "*": no("unscripted git call"),
  });
}

interface ProjectionFixtureOptions {
  baseRef?: string;
  git?: GitExec;
  targetBranch?: () => string;
  approval?: (digest: string) => DeliveryRecoveryApproval;
  omitApprovalResolver?: boolean;
  branchRef?: string;
}

async function projectionFixture(id: string, options: ProjectionFixtureOptions = {}) {
  const workspace = root("tachyon-base-repair-");
  const wt = path.join(workspace, "wt");
  fs.mkdirSync(wt);
  const branchRef = options.branchRef ?? "tachyon/d";
  const deliveries = new DeliveryStore(workspace, { now: () => now });
  const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
  const delivery = await deliveries.create({
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
  });

  const resolveApproval = vi.fn(async (_id: string, _actor: DeliveryActor, digest: string) => (
    options.approval ? options.approval(digest) : approvalBoundTo(digest, approver.name!)
  ));

  const svc = new DeliveryProjectionService({
    deliveries,
    gitDeliveries,
    workspaceRoot: workspace,
    workspaceId: "ws",
    git: options.git ?? repairGitScript(branchRef),
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
    targetBranch: options.targetBranch ?? (() => TARGET_BRANCH),
    ...(options.omitApprovalResolver ? {} : { resolveBaseRepairApproval: resolveApproval }),
    now: () => now,
  });

  const opened = await svc.openCanonical({
    deliveryId: delivery.id,
    agent: "worker",
    branchRef,
    worktreePath: wt,
    tachyonCreatedBranch: false,
    baseRef: options.baseRef ?? PINNED_BASE,
    currentHeadSha: TIP,
    actor: approver,
    operationId: `${id}-open`,
  });

  return { workspace, wt, deliveries, gitDeliveries, svc, delivery, opened, resolveApproval, branchRef };
}

function reconcileBaseInput(id: string, gitDeliveryId: string, version: number, overrides: Partial<{ proposedBaseRef: string; operationId: string }> = {}) {
  return {
    deliveryId: id,
    gitDeliveryId,
    expectedGitVersion: version,
    proposedBaseRef: overrides.proposedBaseRef ?? TARGET_BRANCH,
    approvalId: "a-base-repair",
    actor: human,
    caller: human,
    operationId: overrides.operationId ?? `${id}-repair`,
  };
}

// ===========================================================================
// t-9e57e8 — governed free → abandoned
// ===========================================================================

describe("governed free→abandoned terminal disposition (t-9e57e8)", () => {
  it("refuses free→abandoned when the approval is not bound to the action digest", async () => {
    const { lease, worktree, store } = await freeFixture({
      approval: () => approvalBoundTo("0".repeat(64), approver.name!),
    });
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-free"))!.lease.state).toBe("free");
  });

  it("refuses free→abandoned when no approval capability is available at all", async () => {
    const { lease, worktree, store } = await freeFixture({ omitApprovalResolver: true });
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-free"))!.lease.state).toBe("free");
  });

  it("refuses free→abandoned while the agent is live", async () => {
    const { lease, worktree, store, resolveApproval } = await freeFixture({ liveState: "live" });
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree)))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED" });
    expect((await store.get("d-free"))!.lease.state).toBe("free");
    // Fail-closed before an approval is ever consumed.
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("refuses free→abandoned while agent liveness is unknown", async () => {
    const { lease, worktree, store } = await freeFixture({ liveState: "unknown" });
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree)))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED" });
    expect((await store.get("d-free"))!.lease.state).toBe("free");
  });

  it("refuses free→abandoned while the worktree is dirty", async () => {
    const { lease, worktree, store } = await freeFixture({ clean: false });
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree)))
      .rejects.toMatchObject({ code: "DELIVERY_WORKTREE_DIRTY" });
    expect((await store.get("d-free"))!.lease.state).toBe("free");
  });

  it("refuses free→abandoned when the worktree is occupied", async () => {
    const { lease, worktree, store, resolveApproval } = await freeFixture({
      occupant: { state: "live", agent: "other-agent" },
    });
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree)))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED" });
    expect((await store.get("d-free"))!.lease.state).toBe("free");
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("refuses free→abandoned when the approving actor is the former holder", async () => {
    const { lease, worktree, store } = await freeFixture();
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree, { actor: formerHolder })))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-free"))!.lease.state).toBe("free");
  });

  it("refuses free→abandoned when the observed head is not the expected disposition head", async () => {
    const { lease, worktree, store } = await freeFixture({ headSha: "0000000000000000000000000000000000000000" });
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree)))
      .rejects.toMatchObject({ code: "DELIVERY_HEAD_CHANGED" });
    expect((await store.get("d-free"))!.lease.state).toBe("free");
  });

  it("leaves held-lease semantics intact: a held lease is never free-abandoned", async () => {
    const { lease, worktree, store } = await freeFixture({ held: true });
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree)))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED" });
    const persisted = (await store.get("d-free"))!;
    expect(persisted.lease.state).toBe("held");
    expect(persisted.events.some((e) => e.type === "free_abandoned")).toBe(false);
  });

  it("transitions free→abandoned with not-live + clean + unoccupied + bound approval", async () => {
    const { lease, worktree, store } = await freeFixture();
    const expectedDigest = freeAbandonDigest({
      deliveryId: "d-free", expectedHeadSha: TIP, operationId: "op-free-abandon", actor: approver,
    });

    const abandoned = await lease.abandonFreeDelivery(abandonFreeInput(worktree));

    expect(abandoned.lease.state).toBe("abandoned");
    const event = abandoned.events.at(-1)!;
    expect(event.type).toBe("free_abandoned");
    expect(event.by).toEqual(approver);
    expect(event.detail).toMatchObject({
      approvalId: "a-67f21b",
      actionDigest: expectedDigest,
      payloadHash: "payload-hash-a67f21b",
      evidenceLevel: "liveness-and-cleanliness",
      formerAgent: "worker",
      headSha: TIP,
    });
    // The evidence level is contract: it must not silently degrade to the held path's label.
    expect(event.detail?.evidenceLevel).not.toBe("approval-only");
    expect(JSON.parse(abandoned.lease.reason!)).toEqual({
      cause: "free-terminal-disposition",
      evidenceLevel: "liveness-and-cleanliness",
    });

    const persisted = (await store.get("d-free"))!;
    expect(persisted.lease.state).toBe("abandoned");
    expect(persisted.events.filter((e) => e.type === "free_abandoned")).toHaveLength(1);
  });

  it("releases an open segment as rejected when a free lease still carries one", async () => {
    const { lease, worktree } = await freeFixture({ openTail: true });
    const abandoned = await lease.abandonFreeDelivery(abandonFreeInput(worktree));
    expect(abandoned.lease.state).toBe("abandoned");
    expect(abandoned.segments.at(-1)).toMatchObject({
      id: "seg-0", outcome: "rejected", releasedAt: now, releasedHeadSha: TIP,
    });
  });

  it("is idempotent by operationId and appends no second event on replay", async () => {
    const { lease, worktree, store } = await freeFixture();
    const first = await lease.abandonFreeDelivery(abandonFreeInput(worktree));
    const replay = await lease.abandonFreeDelivery(abandonFreeInput(worktree));

    expect(replay.version).toBe(first.version);
    expect(replay.lease).toEqual(first.lease);
    const persisted = (await store.get("d-free"))!;
    expect(persisted.events.filter((e) => e.type === "free_abandoned")).toHaveLength(1);
  });

  it("refuses a second disposition once the lease is already abandoned", async () => {
    const { lease, worktree } = await freeFixture();
    await lease.abandonFreeDelivery(abandonFreeInput(worktree));
    await expect(lease.abandonFreeDelivery(abandonFreeInput(worktree, { operationId: "op-second" })))
      .rejects.toMatchObject({ code: "DELIVERY_ABANDONED" });
  });
});

// ===========================================================================
// Characterization: the dead end this fix deliberately flips
// ===========================================================================

describe("terminal free lease disposition route (t-9e57e8 characterization)", () => {
  it("gives a terminal free lease a governed route to prune_abandon", async () => {
    const workspace = root("tachyon-dead-end-");
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const branchRef = "tachyon/d";
    const delivery = await deliveries.create({
      id: "d-dead-end",
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
    });

    let removed = false;
    const git = gitScript({
      [`show-ref --verify --quiet refs/heads/${branchRef}`]: () => (removed ? no() : ok()),
      [`rev-parse ${branchRef}`]: ok(`${TIP}\n`),
      "status --porcelain=v1 --untracked-files=all": ok(""),
      [`merge-base --is-ancestor ${TIP} ${PINNED_BASE}`]: no(),
      [`cherry ${PINNED_BASE} ${TIP}`]: no(),
      [`rev-list ${PINNED_BASE}..${branchRef}`]: ok(""),
      "worktree list --porcelain": () => ok(removed ? "" : `worktree ${wt}\nbranch refs/heads/${branchRef}\n`),
      [`worktree remove --force ${wt}`]: () => {
        removed = true;
        fs.rmSync(wt, { recursive: true, force: true });
        return ok();
      },
      "worktree prune": ok(),
      "*": no("unscripted git call"),
    });

    const svc = new DeliveryProjectionService({
      deliveries, gitDeliveries, workspaceRoot: workspace, workspaceId: "ws", git,
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
      now: () => now,
    });
    const opened = await svc.openCanonical({
      deliveryId: delivery.id, agent: "worker", branchRef, worktreePath: wt,
      tachyonCreatedBranch: false, baseRef: PINNED_BASE, currentHeadSha: TIP,
      actor: approver, operationId: "dead-end-open",
    });

    // BASE behavior, pinned: a free lease has no abandoned disposition, so abandon-prune refuses.
    await expect(svc.prune({
      deliveryId: delivery.id, gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version, abandon: true,
      actor: human, caller: human, operationId: "dead-end-prune-refused",
    })).rejects.toThrow(/abandon prune requires abandoned lease \(found free\)/);

    // The new governed edge is what turns that dead end into an exit.
    let events = 0;
    const lease = new DeliveryLeaseService({
      store: deliveries,
      canonicalWorktreeFor: () => wt,
      readHead: () => TIP,
      inspectWorktree: () => ({ headSha: TIP, clean: true }),
      isAncestor: () => true,
      withWorktreeLock: async (_p, fn) => fn(),
      recoveryPrincipals: ["coordinator"],
      agentLiveness: async (): Promise<DeliveryAgentLiveState> => "not_live",
      worktreeOccupancy: async () => undefined,
      resolveRecoveryApproval: async (_id, _actor, digest) => approvalBoundTo(digest, approver.name!),
      now: () => now,
      eventId: () => `dead-end-event-${++events}`,
    });
    const abandoned = await lease.abandonFreeDelivery({
      deliveryId: delivery.id, canonicalWorktree: wt, actor: approver,
      operationId: "dead-end-abandon", expectedHeadSha: TIP, approvalId: "a-67f21b",
    });
    expect(abandoned.lease.state).toBe("abandoned");

    // And the same abandon-prune now completes the disposition.
    const pruned = await svc.prune({
      deliveryId: delivery.id, gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version, abandon: true,
      actor: human, caller: human, operationId: "dead-end-prune-ok",
    });
    expect(pruned.result.ok).toBe(true);
    expect(pruned.projection.phase).toBe("pruned");
  });
});

// ===========================================================================
// t-2dd637 §4 — narrow governed reconcile_base
// ===========================================================================

describe("governed reconcile_base projection repair (t-2dd637 §4)", () => {
  it("refuses to repair a healthy record whose base is already a symbolic branch ref", async () => {
    const { svc, opened, gitDeliveries } = await projectionFixture("d-healthy", {
      baseRef: TARGET_BRANCH,
      git: repairGitScript("tachyon/d", {
        [`show-ref --verify --quiet refs/heads/${TARGET_BRANCH}`]: ok(),
      }),
    });

    await expect(svc.reconcileBase(reconcileBaseInput("d-healthy", opened.projection.id, opened.projection.version)))
      .rejects.toThrow(/already a symbolic branch ref/);

    const after = (await gitDeliveries.get(opened.projection.id))!;
    expect(after.baseRef).toBe(TARGET_BRANCH);
    expect(after.version).toBe(opened.projection.version);
  });

  it("refuses to repair when the stored base is not an ancestor of the proposed base", async () => {
    const { svc, opened, gitDeliveries, deliveries } = await projectionFixture("d-nonancestor", {
      git: repairGitScript("tachyon/d", {
        [`merge-base --is-ancestor ${PINNED_BASE} ${TARGET_BRANCH}`]: no(),
      }),
    });

    await expect(svc.reconcileBase(reconcileBaseInput("d-nonancestor", opened.projection.id, opened.projection.version)))
      .rejects.toThrow(/is not an ancestor of/);

    expect((await gitDeliveries.get(opened.projection.id))!.baseRef).toBe(PINNED_BASE);
    // A refused repair never orphans a projection sequence.
    expect(listProjectionIntents((await deliveries.get("d-nonancestor"))!)
      .filter((i) => i.action === "reconcile_base")).toHaveLength(0);
  });

  it("refuses a proposed base that is not the workspace target branch", async () => {
    const { svc, opened, gitDeliveries } = await projectionFixture("d-offtarget");

    await expect(svc.reconcileBase(reconcileBaseInput("d-offtarget", opened.projection.id, opened.projection.version, {
      proposedBaseRef: "release/1.x",
    }))).rejects.toThrow(/is not the workspace target branch/);

    expect((await gitDeliveries.get(opened.projection.id))!.baseRef).toBe(PINNED_BASE);
  });

  it("refuses when the approval is not bound to the base-repair action digest", async () => {
    const { svc, opened, gitDeliveries } = await projectionFixture("d-unbound", {
      approval: () => approvalBoundTo("0".repeat(64), approver.name!),
    });

    await expect(svc.reconcileBase(reconcileBaseInput("d-unbound", opened.projection.id, opened.projection.version)))
      .rejects.toThrow(/not an exact approved receipt bound to this action digest/);

    expect((await gitDeliveries.get(opened.projection.id))!.baseRef).toBe(PINNED_BASE);
  });

  it("refuses when no base-repair approval capability is available", async () => {
    const { svc, opened, gitDeliveries } = await projectionFixture("d-noapproval", { omitApprovalResolver: true });

    await expect(svc.reconcileBase(reconcileBaseInput("d-noapproval", opened.projection.id, opened.projection.version)))
      .rejects.toThrow(/bound human approval is required/);

    expect((await gitDeliveries.get(opened.projection.id))!.baseRef).toBe(PINNED_BASE);
  });

  it("refuses an unprivileged caller", async () => {
    const { svc, opened } = await projectionFixture("d-unpriv");
    await expect(svc.reconcileBase({
      ...reconcileBaseInput("d-unpriv", opened.projection.id, opened.projection.version),
      actor: { kind: "agent", name: "worker" },
      caller: { kind: "agent", name: "worker" },
    })).rejects.toThrow(/not a privileged human\/system\/master or configured integratePrincipal/);
  });

  it("repairs the defect-class base under a bound approval and records the intent", async () => {
    const { svc, opened, gitDeliveries, deliveries, resolveApproval } = await projectionFixture("d-repair");
    const expectedDigest = baseRepairDigest({
      gitDeliveryId: opened.projection.id,
      currentBaseRef: PINNED_BASE,
      proposedBaseRef: TARGET_BRANCH,
      currentHeadSha: TIP,
    });

    const repaired = await svc.reconcileBase(reconcileBaseInput("d-repair", opened.projection.id, opened.projection.version));

    expect(repaired.projection.baseRef).toBe(TARGET_BRANCH);
    expect(repaired.projection.version).toBe(opened.projection.version + 1);
    expect(repaired.projection.lastAppliedProjectionSequence).toBe(2);
    // The repair is auditable: the approval it consumed was bound to this exact digest.
    expect(resolveApproval).toHaveBeenCalledWith("a-base-repair", human, expectedDigest);

    const intents = listProjectionIntents((await deliveries.get("d-repair"))!)
      .filter((i) => i.action === "reconcile_base");
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      gitDeliveryId: opened.projection.id,
      expected: { baseRef: PINNED_BASE, headSha: TIP },
      payload: { proposedBaseRef: TARGET_BRANCH, approvalId: "a-base-repair", actionDigest: expectedDigest },
    });
    expect((await gitDeliveries.get(opened.projection.id))!.transitions.at(-1)).toMatchObject({
      reason: `governed base repair: pinned SHA '${PINNED_BASE}' restored to target branch '${TARGET_BRANCH}'`,
    });
  });

  it("is idempotent by operationId and mints no second repair intent", async () => {
    const { svc, opened, deliveries } = await projectionFixture("d-repair-replay");
    const first = await svc.reconcileBase(reconcileBaseInput("d-repair-replay", opened.projection.id, opened.projection.version));
    const replay = await svc.reconcileBase(reconcileBaseInput("d-repair-replay", opened.projection.id, opened.projection.version));

    expect(replay.projection.version).toBe(first.projection.version);
    expect(listProjectionIntents((await deliveries.get("d-repair-replay"))!)
      .filter((i) => i.action === "reconcile_base")).toHaveLength(1);
  });

  it("lets the ordinary integrate close the record after the repair, with its own oracle intact", async () => {
    const { svc, opened, gitDeliveries } = await projectionFixture("d-then-integrate");

    // Before the repair, integrate refuses on the containment oracle — the pin is unsatisfiable.
    await expect(svc.integrate({
      deliveryId: "d-then-integrate", gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version, expectedHeadSha: TIP,
      actor: human, caller: human, operationId: "pre-repair-integrate",
    })).rejects.toThrow(/not contained in the resolved base/);

    const repaired = await svc.reconcileBase(reconcileBaseInput("d-then-integrate", opened.projection.id, opened.projection.version));

    // After the repair the same call succeeds — the oracle was satisfied, not weakened.
    const integrated = await svc.integrate({
      deliveryId: "d-then-integrate", gitDeliveryId: repaired.projection.id,
      expectedGitVersion: repaired.projection.version, expectedHeadSha: TIP,
      actor: human, caller: human, operationId: "post-repair-integrate",
    });
    expect(integrated.projection.phase).toBe("integrated");
    expect(integrated.projection.integratedSha).toBe(TIP);
    expect((await gitDeliveries.get(opened.projection.id))!.baseRef).toBe(TARGET_BRANCH);
  });

  it("leaves the repaired base satisfying git's own branch ref grammar", async () => {
    const { svc, opened, gitDeliveries } = await projectionFixture("d-grammar");
    const before = (await gitDeliveries.get(opened.projection.id))!.baseRef;
    await svc.reconcileBase(reconcileBaseInput("d-grammar", opened.projection.id, opened.projection.version));
    const after = (await gitDeliveries.get(opened.projection.id))!.baseRef;

    // Oracle is git's own ref grammar, not anything this codebase produced.
    const grammarOk = (ref: string): boolean => {
      try {
        execFileSync("git", ["check-ref-format", "--branch", ref], { stdio: "ignore" });
        return true;
      } catch { return false; }
    };
    expect(grammarOk(after)).toBe(true);
    // ...and, load-bearing, the repaired base is a *symbolic* ref rather than a pinned object name,
    // which bare ref grammar cannot distinguish (a 40-hex name passes check-ref-format too).
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toMatch(/^[0-9a-f]{40}$/);
    expect(after).toBe(TARGET_BRANCH);
  });
});

// ---------------------------------------------------------------------------
// Construction-site wiring (the fixtures above inject fakes and are therefore
// structurally blind to a dependency that the real product never provides)
// ---------------------------------------------------------------------------

/**
 * Both mechanisms above are optional-dependency shaped: absent dep → fail closed. Every test in
 * this file supplies those deps itself, so all of them stay green even when `Workspace.ts` never
 * wires them and the shipped Bridge surface can never succeed. These tests close that hole by
 * asserting against the services the REAL `Workspace` constructor builds — delete any one of the
 * four wiring lines at the `new DeliveryProjectionService` / `new DeliveryLeaseService` sites and
 * the matching assertion below fails.
 */
class WiringHost implements EngineHost {
  t = (m: string, ...a: (string | number | boolean)[]): string => m.replace(/\{(\d+)\}/g, (_x, i) => String(a[Number(i)] ?? ""));
  notify(): void {}
  focusPrimaryView(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in wiring test: ${command}`));
  }
  watch(): { dispose(): void } {
    return { dispose() {} };
  }
  getSetting<T>(_s: string, _k: string, d: T): T {
    return d;
  }
  globalStoragePath(): string {
    return this.storageDir;
  }
  getState<T>(_k: string): T | undefined {
    return undefined;
  }
  setState(): void {}
  getSecret(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  setSecret(): Promise<void> {
    return Promise.resolve();
  }
  appVersion(): string {
    return "0.0.0-test";
  }
  mediaPath(...s: string[]): string {
    return path.join(this.storageDir, ...s);
  }
  webviewRoot(): unknown {
    return undefined;
  }
  onViewsChanged(): void {}
  constructor(private readonly storageDir: string) {}
}

/** Only the two dependency bags matter here; the services keep them private, so read them structurally. */
type WiredDeps = {
  agentLiveness?: (agent: string) => unknown;
  worktreeOccupancy?: (canonicalWorktree: string) => unknown;
  targetBranch?: () => unknown;
  resolveBaseRepairApproval?: (approvalId: string, actor: DeliveryActor, actionDigest: string) => unknown;
};
const wiredDeps = (service: unknown): WiredDeps => (service as { deps: WiredDeps }).deps;

async function realWorkspace(): Promise<Workspace> {
  const dir = root("tachyon-wiring-");
  execFileSync("git", ["init", "-q", "-b", TARGET_BRANCH, dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "root"], {
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  fs.writeFileSync(path.join(dir, "tachyon.yml"), "agents:\n  worker:\n    cmd: sh\n", "utf8");
  const tmux = new TmuxService(async (): Promise<ExecResult> => ({ stdout: "", stderr: "" }));
  return Workspace.createForTest(dir, { host: new WiringHost(root("tachyon-wiring-storage-")), onViewsChanged: () => {} }, { tmux, startBridge: false });
}

describe("Workspace construction sites supply the governed-recovery evidence dependencies", () => {
  it("wires agentLiveness and worktreeOccupancy onto the real DeliveryLeaseService (t-9e57e8)", async () => {
    const ws = await realWorkspace();
    const deps = wiredDeps(ws.deliveryLease);

    // Present — absent is exactly the defect: abandonFreeDelivery then refuses every real call with
    // "agent liveness evidence is unavailable" / "worktree occupancy evidence is unavailable".
    expect(typeof deps.agentLiveness).toBe("function");
    expect(typeof deps.worktreeOccupancy).toBe("function");

    // ...and bound to the real oracles, not a stub: an unknown agent resolves through the manager's
    // own live-state classification, and an unoccupied path reports no occupant.
    expect(["live", "not_live", "unknown"]).toContain(await deps.agentLiveness!("no-such-agent"));
    await expect(Promise.resolve(deps.worktreeOccupancy!(path.join(ws.workspaceRoot, "absent-worktree")))).resolves.toBeUndefined();
  });

  it("wires targetBranch and resolveBaseRepairApproval onto the real DeliveryProjectionService (t-2dd637 §4)", async () => {
    const ws = await realWorkspace();
    const deps = wiredDeps(ws.deliveryProjection);

    expect(typeof deps.targetBranch).toBe("function");
    expect(typeof deps.resolveBaseRepairApproval).toBe("function");

    // The target branch is the workspace's own checked-out branch — the ref deliveries fork from.
    await expect(Promise.resolve(deps.targetBranch!())).resolves.toBe(TARGET_BRANCH);

    // The approval resolver is bound to the durable approval store: an unknown id cannot resolve.
    await expect(Promise.resolve().then(() => deps.resolveBaseRepairApproval!("ap-does-not-exist", approver, "digest"))).rejects.toThrow();

    // ...and it enforces the same store/binding contract the lease service's recovery approvals do —
    // both refuse a caller with no agent identity, so the base repair cannot redeem on a weaker path.
    const leaseResolver = (wiredDeps(ws.deliveryLease) as unknown as {
      resolveRecoveryApproval: (id: string, actor: DeliveryActor, digest: string) => unknown;
    }).resolveRecoveryApproval;
    const refusal = async (fn: (id: string, actor: DeliveryActor, digest: string) => unknown): Promise<string> => {
      try {
        await fn("ap-does-not-exist", human, "digest");
        return "resolved";
      } catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    expect(await refusal(deps.resolveBaseRepairApproval!)).toBe("recovery approval requires an agent caller");
    expect(await refusal(leaseResolver)).toBe("recovery approval requires an agent caller");
  });
});
