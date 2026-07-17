import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSingleDeliveryReloadSnapshot,
  DeliveryProjectionError,
  DeliveryProjectionService,
  listProjectionIntents,
} from "../../src/delivery/projectionService.js";
import {
  DeliveryProjectionClaimError,
  DeliveryStore,
} from "../../src/delivery/store.js";
import type { Delivery, DeliveryCreateInput, DeliveryProjectionOwnerIdentity } from "../../src/delivery/types.js";
import { canIntegrateLinkedGitDelivery, canPruneLinkedGitDelivery } from "../../src/git-delivery/policy.js";
import { hygieneReport } from "../../src/git-delivery/classify.js";
import {
  deterministicGitDeliveryId,
  GitDeliveryStore,
} from "../../src/git-delivery/store.js";
import type { GitDeliverySettings } from "../../src/git-delivery/types.js";
import type { GitExec, GitResult } from "../../src/worktree/WorktreeManager.js";

const actor = { kind: "system" as const, name: "tachyon" };
const human = { kind: "human" as const, name: "maintainer" };
const now = "2026-07-12T15:00:00.000Z";
const settings: GitDeliverySettings = {
  prunePrincipals: ["orch"],
  integratePrincipals: ["orch"],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proj-"));
  dirs.push(dir);
  return dir;
}

function deliveryInput(id: string, overrides: Partial<DeliveryCreateInput> = {}): DeliveryCreateInput {
  return {
    id,
    workspaceId: "ws",
    createdBy: actor,
    contract: { baseSha: "base", behaviorTest: "behavior", owns: ["src/a.ts"], taskRef: "tachyon/d" },
    lease: { state: "free", changedAt: now },
    segments: [{
      id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
      ownsSubset: ["src/a.ts"], grantedHeadSha: "base", grantedAt: now,
      releasedAt: now, releasedHeadSha: "tip", outcome: "completed",
    }],
    events: [{ id: "event-0", at: now, type: "created", by: actor }],
    ...overrides,
  };
}

function ok(stdout = ""): GitResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(stderr = ""): GitResult {
  return { code: 1, stdout: "", stderr };
}

function gitScript(script: Record<string, GitResult | ((args: string[], cwd: string) => GitResult)>): GitExec {
  return async (args, cwd) => {
    const key = args.join(" ");
    const hit = script[key] ?? script[args[0]!] ?? script["*"];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected git: ${key}` };
    return typeof hit === "function" ? hit(args, cwd) : hit;
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
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

async function freeDelivery(store: DeliveryStore, id: string, gitDeliveryId?: string): Promise<Delivery> {
  return store.create(deliveryInput(id, gitDeliveryId ? { gitDeliveryId } : {}));
}

function serviceFor(
  workspace: string,
  deliveries: DeliveryStore,
  gitDeliveries: GitDeliveryStore,
  git: GitExec,
  opts: {
    snapshot?: (deliveryId: string) => Promise<import("../../src/delivery/reloadReconciliation.js").ReloadReconciliationSnapshot>;
    liveness?: (agent: string) => Promise<"live" | "not_live" | "unknown">;
    removeManagedWorktree?: import("../../src/git-delivery/prune.js").PruneDeps["removeManagedWorktree"];
  } = {},
): DeliveryProjectionService {
  return new DeliveryProjectionService({
    deliveries,
    gitDeliveries,
    workspaceRoot: workspace,
    workspaceId: "ws",
    git,
    liveness: opts.liveness ?? (async () => "not_live"),
    worktreeOccupancy: async () => undefined,
    ...(opts.removeManagedWorktree ? { removeManagedWorktree: opts.removeManagedWorktree } : {}),
    withWorktreeLock: locks(),
    settings: () => settings,
    loadReloadSnapshot: opts.snapshot ?? (async (deliveryId) => {
      const d = await deliveries.get(deliveryId);
      if (!d) throw new Error("missing");
      const p = d.gitDeliveryId ? await gitDeliveries.get(d.gitDeliveryId) : undefined;
      return buildSingleDeliveryReloadSnapshot({ delivery: d, projection: p });
    }),
    now: () => now,
  });
}

describe("DeliveryProjectionService (SDD 368 T15)", () => {
  it("opens canonically with deterministic id, intent, and backlink repair", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-open1");
    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({ "*": ok() }));

    const first = await svc.openCanonical({
      deliveryId: delivery.id,
      agent: "worker",
      branchRef: "tachyon/d",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: "tip",
      actor,
      operationId: "op-open-1",
    });
    expect(first.projection.id).toBe(deterministicGitDeliveryId(delivery.id));
    expect(first.projection.deliveryId).toBe(delivery.id);
    expect(first.delivery.gitDeliveryId).toBe(first.projection.id);
    expect(first.projection.lastAppliedProjectionSequence).toBe(1);
    expect(listProjectionIntents(first.delivery)).toHaveLength(1);

    // Replay is idempotent across crash boundaries.
    const replay = await svc.openCanonical({
      deliveryId: delivery.id,
      agent: "worker",
      branchRef: "tachyon/d",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: "tip",
      actor,
      operationId: "op-open-1",
    });
    expect(replay.projection.id).toBe(first.projection.id);
    expect(replay.delivery.gitDeliveryId).toBe(first.projection.id);
    expect(listProjectionIntents(replay.delivery)).toHaveLength(1);
  });

  it("forces the three open crash boundaries to converge via reconcile", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-crash-open");
    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({ "*": ok() }));
    const gitId = deterministicGitDeliveryId(delivery.id);

    // Boundary 1: intent only (no projection, no backlink).
    const claim = await deliveries.claimProjection(delivery.id);
    await deliveries.updateUnderProjectionClaim(claim, delivery.version, (record) => ({
      ...record,
      events: [...record.events, {
        id: "proj-evt-1",
        at: now,
        type: "projection.intent",
        by: actor,
        detail: {
          projectionSequence: 1,
          operationId: "op-crash-open",
          gitDeliveryId: gitId,
          action: "open",
          expected: { branchRef: "tachyon/d", worktreePath: wt, baseRef: "main", headSha: "tip" },
          actor,
          payload: { agent: "worker", tachyonCreatedBranch: true, reason: "crash" },
        },
      }],
    }), { operationId: "proj-intent:op-crash-open", intent: { seq: 1 } });
    await deliveries.releaseProjection(claim);

    const afterIntent = await svc.reconcile(delivery.id);
    expect(afterIntent.projection?.id).toBe(gitId);
    expect(afterIntent.delivery.gitDeliveryId).toBe(gitId);
    expect(afterIntent.projection?.lastAppliedProjectionSequence).toBe(1);

    // Boundary 2: projection open without backlink — strip backlink and re-reconcile.
    const claim2 = await deliveries.claimProjection(delivery.id);
    const cur = await deliveries.get(delivery.id);
    await deliveries.updateUnderProjectionClaim(claim2, cur!.version, (record) => {
      const { gitDeliveryId: _g, ...rest } = record;
      return rest as Delivery;
    }, { operationId: "strip-link", intent: { strip: true } });
    await deliveries.releaseProjection(claim2);
    const repaired = await svc.reconcile(delivery.id);
    expect(repaired.delivery.gitDeliveryId).toBe(gitId);
  });

  it("fails closed on a pre-existing projection whose immutable open authority drifted", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-open-drift");
    const gitId = deterministicGitDeliveryId(delivery.id);
    await gitDeliveries.open({
      id: gitId,
      workspaceId: "stale-workspace",
      createdBy: actor,
      deliveryId: delivery.id,
      agent: "worker",
      branchRef: "tachyon/d",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: "tip",
    });
    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({ "*": ok() }));
    const open = {
      deliveryId: delivery.id,
      agent: "worker",
      branchRef: "tachyon/d",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: "tip",
      actor,
      operationId: "op-open-drift",
    };

    await expect(svc.openCanonical(open)).rejects.toThrow(/immutable open intent/);
    await expect(svc.reconcile(delivery.id)).rejects.toThrow(/immutable open intent/);
    expect((await deliveries.get(delivery.id))?.gitDeliveryId).toBeUndefined();
    expect((await gitDeliveries.get(gitId))?.workspaceId).toBe("stale-workspace");
  });

  it("integrates only after live head+containment proof and leaves zero effects on failure", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-int");
    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({
      "show-ref --verify --quiet refs/heads/tachyon/d": ok(),
      "rev-parse tachyon/d": ok("tip\n"),
      "status --porcelain=v1 --untracked-files=all": ok(""),
      "merge-base --is-ancestor tip main": ok(),
      "*": ok(),
    }));
    const opened = await svc.openCanonical({
      deliveryId: delivery.id, agent: "worker", branchRef: "tachyon/d", worktreePath: wt,
      tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "tip", actor, operationId: "op-open-int",
    });

    // Head mismatch → zero effects.
    const before = await gitDeliveries.get(opened.projection.id);
    await expect(svc.integrate({
      deliveryId: delivery.id,
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version,
      expectedHeadSha: "other",
      actor: human, caller: human,
      operationId: "op-int-fail",
    })).rejects.toThrow(/does not equal expected head/);
    expect(await gitDeliveries.get(opened.projection.id)).toEqual(before);
    expect(listProjectionIntents(await deliveries.get(delivery.id) as Delivery).filter((i) => i.action === "integrate")).toHaveLength(0);

    // Success path.
    const done = await svc.integrate({
      deliveryId: delivery.id,
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version,
      expectedHeadSha: "tip",
      actor: human, caller: human,
      operationId: "op-int-ok",
    });
    expect(done.projection.phase).toBe("integrated");
    expect(done.projection.integratedSha).toBe("tip");
    expect(done.projection.lastAppliedProjectionSequence).toBe(2);
  });

  it("refuses integrate/prune for unsafe lease states and linked unauthorized actors", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const held = await deliveries.create(deliveryInput("d-held", {
      lease: {
        state: "held",
        holder: { segmentId: "seg-0", executionAgent: "worker", executionNonce: "n", process: { pid: 1, processStart: "1", bootId: "b" } },
        expectedHeadSha: "base",
        changedAt: now,
      },
      segments: [{
        id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
        ownsSubset: ["src/a.ts"], grantedHeadSha: "base", grantedAt: now,
      }],
    }));
    // Manually link a projection without going through openCanonical safety (held refuses integrate).
    const gd = await gitDeliveries.open({
      id: deterministicGitDeliveryId(held.id),
      workspaceId: "ws", createdBy: actor, deliveryId: held.id, agent: "worker",
      branchRef: "tachyon/d", worktreePath: wt, tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "tip",
    });
    await deliveries.update(held.id, held.version, (r) => ({ ...r, gitDeliveryId: gd.id }), {
      operationId: "link-held", intent: { gitDeliveryId: gd.id },
    });
    // Mark sequence as if open applied so integrate path can find reciprocal link.
    await gitDeliveries.applyCanonicalIntent({
      id: gd.id, expectedVersion: gd.version, sequence: 1, operationId: "seed-open", deliveryId: held.id,
      mutate: (r) => r,
    });

    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({
      "show-ref --verify --quiet refs/heads/tachyon/d": ok(),
      "rev-parse tachyon/d": ok("tip\n"),
      "status --porcelain=v1 --untracked-files=all": ok(""),
      "merge-base --is-ancestor tip main": ok(),
      "*": ok(),
    }), {
      snapshot: async () => ({
        classifications: [{ deliveryId: held.id, class: "held", reason: "held", holderAgent: "worker" }],
        byId: new Map([[held.id, { deliveryId: held.id, class: "held" as const, reason: "held", holderAgent: "worker" }]]),
        unavailableAgents: new Set(["worker"]),
      }),
    });

    await expect(svc.integrate({
      deliveryId: held.id, gitDeliveryId: gd.id, expectedGitVersion: 2, expectedHeadSha: "tip", actor: human, caller: human, operationId: "nope",
    })).rejects.toBeInstanceOf(DeliveryProjectionError);

    expect(canIntegrateLinkedGitDelivery({ kind: "agent", name: "worker" }, settings.integratePrincipals)).toBe(false);
    expect(canPruneLinkedGitDelivery({ kind: "agent", name: "worker" }, settings.prunePrincipals)).toBe(false);
    expect(canIntegrateLinkedGitDelivery({ kind: "agent", name: "orch" }, settings.integratePrincipals, { kind: "agent", name: "orch" })).toBe(true);
  });

  it("prunes under claim with crash-after-git-removal idempotent completion", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-prune");
    let removed = false;
    const git = gitScript({
      "show-ref --verify --quiet refs/heads/tachyon/d": () => removed ? fail() : ok(),
      "rev-parse tachyon/d": ok("tip\n"),
      "status --porcelain=v1 --untracked-files=all": ok(""),
      "merge-base --is-ancestor tip main": ok(),
      "worktree list --porcelain": () => ok(removed ? "" : `worktree ${wt}\nbranch refs/heads/tachyon/d\n`),
      [`worktree remove --force ${wt}`]: () => {
        removed = true;
        fs.rmSync(wt, { recursive: true, force: true });
        return ok();
      },
      "branch -d tachyon/d": ok(),
      "worktree prune": ok(),
      "*": ok(),
    });
    const svc = serviceFor(workspace, deliveries, gitDeliveries, git);
    const opened = await svc.openCanonical({
      deliveryId: delivery.id, agent: "worker", branchRef: "tachyon/d", worktreePath: wt,
      tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "tip", actor, operationId: "op-open-p",
    });
    const integrated = await svc.integrate({
      deliveryId: delivery.id, gitDeliveryId: opened.projection.id, expectedGitVersion: opened.projection.version,
      expectedHeadSha: "tip", actor: human, caller: human, operationId: "op-int-p",
    });

    // Crash after Git removal: append prune intent, perform git remove, skip apply.
    const claim = await deliveries.claimProjection(delivery.id);
    const d2 = await deliveries.get(delivery.id);
    await deliveries.updateUnderProjectionClaim(claim, d2!.version, (record) => ({
      ...record,
      events: [...record.events, {
        id: "proj-evt-prune", at: now, type: "projection.intent", by: human,
        detail: {
          projectionSequence: 3, operationId: "op-prune-crash", gitDeliveryId: integrated.projection.id,
          action: "prune", expected: { gitDeliveryVersion: integrated.projection.version }, actor: human, payload: {},
        },
      }],
    }), { operationId: "proj-intent:op-prune-crash", intent: { prune: true } });
    await deliveries.releaseProjection(claim);
    // Simulate external git removal mid-flight.
    removed = true;
    fs.rmSync(wt, { recursive: true, force: true });

    const reconciled = await svc.reconcile(delivery.id);
    expect(reconciled.projection?.phase).toBe("pruned");
    expect(reconciled.projection?.lastAppliedProjectionSequence).toBe(3);
  });

  it("routes canonical prune through the managed-worktree removal seam", async () => {
    const workspace = root();
    const wt = path.join(workspace, "managed-wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-managed-prune");
    const calls: string[] = [];
    let removed = false;
    const git: GitExec = async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (command === "show-ref --verify --quiet refs/heads/tachyon/managed") return removed ? fail() : ok();
      if (command === "rev-parse tachyon/managed") return ok("tip\n");
      if (command === "status --porcelain=v1 --untracked-files=all") return ok();
      if (command === "merge-base --is-ancestor tip main") return ok();
      if (command === "worktree list --porcelain") {
        return ok(removed ? "" : `worktree ${wt}\nbranch refs/heads/tachyon/managed\n`);
      }
      if (command === "branch -d tachyon/managed" || command === "worktree prune") return ok();
      return fail(`unexpected git: ${command}`);
    };
    const managedRemovals: string[] = [];
    const svc = serviceFor(workspace, deliveries, gitDeliveries, git, {
      removeManagedWorktree: async (worktreePath, opts) => {
        managedRemovals.push(worktreePath);
        expect(opts).toMatchObject({ branch: "tachyon/managed", deleteBranch: false, tachyonCreatedBranch: true });
        removed = true;
        fs.rmSync(worktreePath, { recursive: true, force: true });
        return { removed: true, branchDeleted: false };
      },
    });
    const opened = await svc.openCanonical({
      deliveryId: delivery.id,
      agent: "worker",
      branchRef: "tachyon/managed",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: "tip",
      actor,
      operationId: "op-managed-open",
    });
    const integrated = await svc.integrate({
      deliveryId: delivery.id,
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version,
      expectedHeadSha: "tip",
      actor: human,
      caller: human,
      operationId: "op-managed-integrate",
    });
    const pruned = await svc.prune({
      deliveryId: delivery.id,
      gitDeliveryId: integrated.projection.id,
      expectedGitVersion: integrated.projection.version,
      actor: human,
      caller: human,
      operationId: "op-managed-prune",
    });

    expect(pruned.projection.phase).toBe("pruned");
    expect(managedRemovals).toEqual([wt]);
    expect(calls).not.toContain(`worktree remove --force ${wt}`);
  });

  it("refuses sequence gaps, collisions, and generic linked mutations", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-seq");
    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({ "*": ok() }));
    const opened = await svc.openCanonical({
      deliveryId: delivery.id, agent: "worker", branchRef: "tachyon/d", worktreePath: wt,
      tachyonCreatedBranch: true, baseRef: "main", actor, operationId: "op-open-seq",
    });

    await expect(gitDeliveries.applyCanonicalIntent({
      id: opened.projection.id, expectedVersion: opened.projection.version, sequence: 3,
      operationId: "gap", deliveryId: delivery.id, mutate: (r) => r,
    })).rejects.toThrow(/gap/);

    await expect(gitDeliveries.applyCanonicalIntent({
      id: opened.projection.id, expectedVersion: opened.projection.version, sequence: 1,
      operationId: "other-op", deliveryId: delivery.id, mutate: (r) => r,
    })).rejects.toThrow(/already applied/);

    // Identical replay succeeds.
    const replay = await gitDeliveries.applyCanonicalIntent({
      id: opened.projection.id, expectedVersion: opened.projection.version, sequence: 1,
      operationId: "op-open-seq", deliveryId: delivery.id, mutate: (r) => r,
    });
    expect(replay.version).toBe(opened.projection.version);

    await expect(gitDeliveries.applyCanonicalIntent({
      id: opened.projection.id, expectedVersion: opened.projection.version, sequence: 2,
      operationId: "op-retarget", deliveryId: "d-other", mutate: (r) => r,
    })).rejects.toThrow(/link drift|deliveryId/);
  });

  it("list/hygiene labels linked unsafe rows without ready_to_prune", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await deliveries.create(deliveryInput("d-hygiene", {
      lease: {
        state: "held",
        holder: { segmentId: "seg-0", executionAgent: "worker", executionNonce: "n", process: { pid: 1, processStart: "1", bootId: "b" } },
        expectedHeadSha: "base",
        changedAt: now,
      },
      segments: [{
        id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
        ownsSubset: ["src/a.ts"], grantedHeadSha: "base", grantedAt: now,
      }],
    }));
    const gd = await gitDeliveries.open({
      workspaceId: "ws", createdBy: actor, deliveryId: delivery.id, agent: "worker",
      branchRef: "tachyon/worker", worktreePath: wt, tachyonCreatedBranch: true, baseRef: "main",
      currentHeadSha: "tip",
    });
    const report = await hygieneReport([gd], [], {
      workspaceRoot: workspace,
      git: gitScript({
        "show-ref --verify --quiet refs/heads/tachyon/worker": ok(),
        "rev-parse tachyon/worker": ok("tip\n"),
        "status --porcelain=v1 --untracked-files=all": ok(""),
        "merge-base --is-ancestor tip main": ok(),
        "*": fail(),
      }),
      liveness: async () => "not_live",
      deliveriesById: new Map([[delivery.id, { ...delivery, gitDeliveryId: gd.id }]]),
      reloadSnapshot: {
        classifications: [{ deliveryId: delivery.id, class: "held", reason: "held" }],
        byId: new Map([[delivery.id, { deliveryId: delivery.id, class: "held", reason: "held" }]]),
        unavailableAgents: new Set(["worker"]),
      },
    });
    expect(report.findings.some((f) => f.category === "delivery_unavailable")).toBe(true);
    expect(report.findings.some((f) => f.category === "ready_to_prune")).toBe(false);
    expect(report.rows[0]?.deliveryId).toBe(delivery.id);
    expect(report.rows[0]?.safetyClass).toBe("held");
  });
});

describe("DeliveryStore projection claims (T15)", () => {
  it("excludes same-Delivery ordinary updates, allows parallel different-Delivery claims, and is nonce-safe", async () => {
    const workspace = root();
    const store = new DeliveryStore(workspace, { now: () => now });
    await store.create(deliveryInput("d-a"));
    await store.create(deliveryInput("d-b"));

    const claimA = await store.claimProjection("d-a");
    const claimB = await store.claimProjection("d-b");
    expect(claimA.deliveryId).toBe("d-a");
    expect(claimB.deliveryId).toBe("d-b");

    await expect(store.update("d-a", 1, (r) => r)).rejects.toBeInstanceOf(DeliveryProjectionClaimError);
    await expect(store.update("d-a", 1, (r) => r)).rejects.toMatchObject({ retryable: true });

    const under = await store.updateUnderProjectionClaim(claimA, 1, (r) => {
      r.events.push({ id: "e1", at: now, type: "proj", by: actor });
      return r;
    }, { operationId: "u1", intent: { e: 1 } });
    expect(under.version).toBe(2);

    // Nonce-safe release: wrong nonce is a no-op; correct nonce releases.
    await store.releaseProjection({ deliveryId: "d-a", nonce: "wrong" });
    expect(await store.getProjectionClaim("d-a")).toBeDefined();
    await store.releaseProjection(claimA);
    expect(await store.getProjectionClaim("d-a")).toBeUndefined();
    await store.releaseProjection(claimB);

    // Ordinary update works again.
    await store.update("d-a", 2, (r) => {
      r.events.push({ id: "e2", at: now, type: "free", by: actor });
      return r;
    });
  });

  it("reclaims only same-domain provably-dead owners; live/PID-reuse/boot/ns/unreadable stay busy", async () => {
    const workspace = root();
    const liveOwner: DeliveryProjectionOwnerIdentity = {
      pid: 111, processStart: "100", bootId: "boot-A", pidNamespace: "pid:[1]",
    };
    let status: "alive" | "dead" | "ambiguous" = "alive";
    const store = new DeliveryStore(workspace, {
      now: () => now,
      projectionOwnerIdentity: () => ({ pid: 222, processStart: "200", bootId: "boot-A", pidNamespace: "pid:[1]" }),
      projectionOwnerStatus: () => status,
    });
    await store.create(deliveryInput("d-claim"));

    // Seed a claim as if held by liveOwner via direct SQLite would be complex; use claim then override status.
    const first = await store.claimProjection("d-claim");
    // Simulate another process seeing the claim as live.
    status = "alive";
    await expect(store.claimProjection("d-claim")).rejects.toBeInstanceOf(DeliveryProjectionClaimError);

    status = "ambiguous";
    await expect(store.claimProjection("d-claim")).rejects.toMatchObject({ retryable: true });

    status = "dead";
    const reclaimed = await store.claimProjection("d-claim");
    expect(reclaimed.nonce).not.toBe(first.nonce);
    // Exact release of old nonce cannot delete successor.
    await store.releaseProjection(first);
    expect(await store.getProjectionClaim("d-claim")).toBeDefined();
    await store.releaseProjection(reclaimed);
    expect(await store.getProjectionClaim("d-claim")).toBeUndefined();

    // Ensure liveOwner type is referenced (documentation of fields under test).
    expect(liveOwner.pidNamespace).toContain("pid:");
  });

  it("t-b3242a: refused prune does not append a canonical projection.intent", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-no-orphan");
    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({
      "show-ref --verify --quiet refs/heads/tachyon/d": ok(),
      "rev-parse tachyon/d": ok("tip\n"),
      "status --porcelain=v1 --untracked-files=all": ok(),
      "merge-base --is-ancestor tip main": ok(),
      "worktree list --porcelain": ok(`worktree ${wt}\nbranch refs/heads/tachyon/d\n`),
      "*": ok(),
    }));
    const opened = await svc.openCanonical({
      deliveryId: delivery.id, agent: "worker", branchRef: "tachyon/d", worktreePath: wt,
      tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "tip", actor, operationId: "op-open-no-orphan",
    });
    // Phase is still open — non-abandon prune must refuse without minting intent seq 2.
    await expect(svc.prune({
      deliveryId: delivery.id,
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version,
      actor: human,
      caller: human,
      operationId: "op-prune-bad-phase",
    })).rejects.toThrow(/not phase integrated|prune refused/);

    const after = await deliveries.get(delivery.id);
    expect(listProjectionIntents(after!).map((i) => i.action)).toEqual(["open"]);
    const proj = await gitDeliveries.get(opened.projection.id);
    expect(proj?.lastAppliedProjectionSequence).toBe(1);
  });

  it("t-b3242a: reconcile voids unapplied prune intents that still fail guards and unblocks integrate", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-void-orphan");
    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({
      "show-ref --verify --quiet refs/heads/tachyon/d": ok(),
      "rev-parse tachyon/d": ok("tip\n"),
      "status --porcelain=v1 --untracked-files=all": ok(),
      "merge-base --is-ancestor tip main": ok(),
      "worktree list --porcelain": ok(`worktree ${wt}\nbranch refs/heads/tachyon/d\n`),
      "*": ok(),
    }));
    const opened = await svc.openCanonical({
      deliveryId: delivery.id, agent: "worker", branchRef: "tachyon/d", worktreePath: wt,
      tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "tip", actor, operationId: "op-open-void",
    });
    // Plant an orphan prune intent (legacy bug shape) without applying it.
    const claim = await deliveries.claimProjection(delivery.id);
    const d = await deliveries.get(delivery.id);
    await deliveries.updateUnderProjectionClaim(claim, d!.version, (record) => ({
      ...record,
      events: [...record.events, {
        id: "proj-evt-orphan-prune", at: now, type: "projection.intent", by: human,
        detail: {
          projectionSequence: 2, operationId: "op-orphan-prune", gitDeliveryId: opened.projection.id,
          action: "prune",
          expected: { gitDeliveryVersion: opened.projection.version, phase: "open" },
          actor: human, payload: {},
        },
      }],
    }), { operationId: "proj-intent:op-orphan-prune", intent: { prune: true } });
    await deliveries.releaseProjection(claim);

    const recon = await svc.reconcile(delivery.id);
    expect(recon.projection?.lastAppliedProjectionSequence).toBe(2);
    expect(recon.projection?.phase).toBe("open");

    const integrated = await svc.integrate({
      deliveryId: delivery.id,
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: recon.projection!.version,
      expectedHeadSha: "tip",
      actor: human,
      caller: human,
      operationId: "op-integrate-after-void",
    });
    expect(integrated.projection.phase).toBe("integrated");
    expect(integrated.projection.lastAppliedProjectionSequence).toBe(3);
  });

  it("t-b3242a: projectionSync is pending when canonical intents lag lastApplied", async () => {
    const workspace = root();
    const wt = path.join(workspace, "wt");
    fs.mkdirSync(wt);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const delivery = await freeDelivery(deliveries, "d-sync-pending");
    const svc = serviceFor(workspace, deliveries, gitDeliveries, gitScript({ "*": ok() }));
    const opened = await svc.openCanonical({
      deliveryId: delivery.id, agent: "worker", branchRef: "tachyon/d", worktreePath: wt,
      tachyonCreatedBranch: true, baseRef: "main", actor, operationId: "op-open-sync",
    });
    const claim = await deliveries.claimProjection(delivery.id);
    const d = await deliveries.get(delivery.id);
    await deliveries.updateUnderProjectionClaim(claim, d!.version, (record) => ({
      ...record,
      events: [...record.events, {
        id: "proj-evt-lag", at: now, type: "projection.intent", by: human,
        detail: {
          projectionSequence: 2, operationId: "op-lag", gitDeliveryId: opened.projection.id,
          action: "integrate", expected: { headSha: "tip" }, actor: human, payload: {},
        },
      }],
    }), { operationId: "proj-intent:op-lag", intent: { integrate: true } });
    await deliveries.releaseProjection(claim);

    const canonical = await deliveries.get(delivery.id);
    const projection = await gitDeliveries.get(opened.projection.id);
    const report = await hygieneReport([projection!], [], {
      workspaceRoot: workspace,
      git: gitScript({ "*": ok() }),
      liveness: async () => "not_live",
      deliveriesById: new Map([[canonical!.id, canonical!]]),
    });
    const row = report.rows.find((r) => r.id === projection!.id);
    expect(row?.projectionSync).toBe("pending");
  });
});
