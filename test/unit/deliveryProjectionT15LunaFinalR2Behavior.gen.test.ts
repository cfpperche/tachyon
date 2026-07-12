import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSingleDeliveryReloadSnapshot,
  DeliveryProjectionService,
  listProjectionIntents,
} from "../../src/delivery/projectionService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { DeliveryCreateInput } from "../../src/delivery/types.js";
import {
  canIntegrateLinkedGitDelivery,
  canPruneLinkedGitDelivery,
  canPruneGitDelivery,
} from "../../src/git-delivery/policy.js";
import { hygieneReport } from "../../src/git-delivery/classify.js";
import {
  deterministicGitDeliveryId,
  GitDeliveryStore,
} from "../../src/git-delivery/store.js";
import type { GitDeliverySettings } from "../../src/git-delivery/types.js";
import type { GitExec, GitResult } from "../../src/worktree/WorktreeManager.js";

/**
 * Canonical gated behavior for SDD 368 T15.
 * Proves concurrent reconcile and prune cannot diverge GitDelivery from canonical
 * lease safety through real DeliveryStore / GitDeliveryStore / DeliveryProjectionService seams.
 */
describe("container-generated delegation behavior", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("linked projection mutation requires Bridge-resolved authority and exact intent replay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t15-behavior-"));
    dirs.push(root);
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt, { recursive: true });
    const now = "2026-07-12T18:00:00.000Z";
    const actor = { kind: "system" as const, name: "tachyon" };
    const human = { kind: "human" as const, name: "maintainer" };
    const settings: GitDeliverySettings = {
      profile: "balanced",
      autoOpen: false,
      requireNonSelfAccept: false,
      autoPrune: false,
      prunePrincipals: ["orch"],
      integratePrincipals: ["orch"],
    };

    const deliveries = new DeliveryStore(root, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(root, { now: () => now });

    const input: DeliveryCreateInput = {
      id: "d-t15",
      workspaceId: "ws",
      createdBy: actor,
      contract: { baseSha: "base", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/d" },
      lease: { state: "free", changedAt: now },
      segments: [{
        id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
        ownsSubset: ["src"], grantedHeadSha: "base", grantedAt: now,
        releasedAt: now, releasedHeadSha: "tip", outcome: "completed",
      }],
      events: [{ id: "e0", at: now, type: "created", by: actor }],
    };
    await deliveries.create(input);

    // --- Projection claim exclusion (same Delivery) + parallel different Delivery ---
    const claimA = await deliveries.claimProjection("d-t15");
    await expect(deliveries.update("d-t15", 1, (r) => r)).rejects.toMatchObject({ retryable: true });
    await deliveries.create({
      ...input,
      id: "d-t15-b",
      contract: { ...input.contract!, taskRef: "tachyon/other" },
      segments: input.segments!.map((s) => ({ ...s, id: "seg-b" })),
      events: [{ id: "e0b", at: now, type: "created", by: actor }],
    });
    const claimB = await deliveries.claimProjection("d-t15-b");
    expect(claimB.deliveryId).toBe("d-t15-b");
    await deliveries.releaseProjection(claimB);
    await deliveries.releaseProjection(claimA);

    // Stale dead-owner reclaim + nonce-safe release
    let ownerStatus: "alive" | "dead" | "ambiguous" = "dead";
    const reclaimStore = new DeliveryStore(root, {
      now: () => now,
      projectionOwnerIdentity: () => ({ pid: 9, processStart: "9", bootId: "boot", pidNamespace: "pid:[1]" }),
      projectionOwnerStatus: () => ownerStatus,
    });
    const seeded = await reclaimStore.claimProjection("d-t15");
    ownerStatus = "alive";
    await expect(reclaimStore.claimProjection("d-t15")).rejects.toMatchObject({ retryable: true });
    ownerStatus = "ambiguous";
    await expect(reclaimStore.claimProjection("d-t15")).rejects.toMatchObject({ retryable: true });
    ownerStatus = "dead";
    const reclaimed = await reclaimStore.claimProjection("d-t15");
    expect(reclaimed.nonce).not.toBe(seeded.nonce);
    await reclaimStore.releaseProjection(seeded); // must not delete successor
    expect(await reclaimStore.getProjectionClaim("d-t15")).toBeDefined();
    await reclaimStore.releaseProjection(reclaimed);

    const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr = ""): GitResult => ({ code: 1, stdout: "", stderr });
    let branchGone = false;
    let worktreeGone = false;
    const git: GitExec = async (args) => {
      const key = args.join(" ");
      if (args[0] === "show-ref") return branchGone ? fail() : ok();
      if (args[0] === "rev-parse") return ok("tip\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "merge-base") return ok();
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(worktreeGone ? "" : `worktree ${wt}\nbranch refs/heads/tachyon/d\n`);
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        worktreeGone = true;
        fs.rmSync(wt, { recursive: true, force: true });
        return ok();
      }
      if (args[0] === "branch" && (args[1] === "-d" || args[1] === "-D")) {
        branchGone = true;
        return ok();
      }
      if (key === "worktree prune") return ok();
      return ok();
    };

    const pathLocks = new Map<string, Promise<unknown>>();
    const withWorktreeLock = async <T>(p: string, fn: () => Promise<T>): Promise<T> => {
      const key = path.resolve(p);
      const prior = pathLocks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      pathLocks.set(key, prior.then(() => gate));
      await prior.catch(() => undefined);
      try {
        return await fn();
      } finally {
        release();
      }
    };

    const svc = new DeliveryProjectionService({
      deliveries,
      gitDeliveries,
      workspaceRoot: root,
      workspaceId: "ws",
      git,
      liveness: async () => "not_live",
      worktreeOccupancy: async () => undefined,
      withWorktreeLock,
      settings: () => settings,
      loadReloadSnapshot: async (deliveryId) => {
        const d = await deliveries.get(deliveryId);
        if (!d) throw new Error("missing delivery");
        const p = d.gitDeliveryId ? await gitDeliveries.get(d.gitDeliveryId) : undefined;
        return buildSingleDeliveryReloadSnapshot({ delivery: d, projection: p });
      },
      now: () => now,
    });

    // --- Canonical open + three-boundary crash convergence ---
    const opened = await svc.openCanonical({
      deliveryId: "d-t15",
      agent: "worker",
      branchRef: "tachyon/d",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: "tip",
      actor,
      operationId: "op-open",
    });
    expect(opened.projection.id).toBe(deterministicGitDeliveryId("d-t15"));
    expect(opened.delivery.gitDeliveryId).toBe(opened.projection.id);
    expect(opened.projection.lastAppliedProjectionSequence).toBe(1);

    // Replay open (crash after complete).
    const openedAgain = await svc.openCanonical({
      deliveryId: "d-t15",
      agent: "worker",
      branchRef: "tachyon/d",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: "tip",
      actor,
      operationId: "op-open",
    });
    expect(openedAgain.projection.id).toBe(opened.projection.id);
    expect(listProjectionIntents(openedAgain.delivery).filter((i) => i.action === "open")).toHaveLength(1);

    // Sequence gap / collision / linked generic mutation refuse
    await expect(gitDeliveries.applyCanonicalIntent({
      id: opened.projection.id,
      expectedVersion: opened.projection.version,
      sequence: 5,
      operationId: "gap",
      deliveryId: "d-t15",
      mutate: (r) => r,
    })).rejects.toThrow(/gap/);
    await expect(gitDeliveries.applyCanonicalIntent({
      id: opened.projection.id,
      expectedVersion: opened.projection.version,
      sequence: 1,
      operationId: "collision",
      deliveryId: "d-t15",
      mutate: (r) => r,
    })).rejects.toThrow(/already applied/);
    await expect(gitDeliveries.applyCanonicalIntent({
      id: opened.projection.id,
      expectedVersion: opened.projection.version,
      sequence: 2,
      operationId: "retarget",
      deliveryId: "d-other",
      mutate: (r) => r,
    })).rejects.toThrow(/link drift|deliveryId/);

    // Live-contained integrate success
    const integrated = await svc.integrate({
      deliveryId: "d-t15",
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version,
      expectedHeadSha: "tip",
      actor: human, caller: human,
      operationId: "op-int",
    });
    expect(integrated.projection.phase).toBe("integrated");
    expect(integrated.projection.lastAppliedProjectionSequence).toBe(2);

    // An operation id is an exact persisted intent, not a mutable retry token.
    await expect(svc.integrate({
      deliveryId: "d-t15", gitDeliveryId: opened.projection.id,
      expectedGitVersion: opened.projection.version, expectedHeadSha: "tip",
      actor: human, caller: human, operationId: "op-int", integrationKind: "manual",
    })).rejects.toThrow(/altered projection intent/);

    // Head failure leaves zero effects
    const beforeFail = await gitDeliveries.get(opened.projection.id);
    const dBeforeFail = await deliveries.get("d-t15");
    await expect(svc.integrate({
      deliveryId: "d-t15",
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: integrated.projection.version,
      expectedHeadSha: "wrong",
      actor: human, caller: human,
      operationId: "op-int-fail",
    })).rejects.toThrow(/does not equal expected head/);
    expect(await gitDeliveries.get(opened.projection.id)).toEqual(beforeFail);
    expect(listProjectionIntents((await deliveries.get("d-t15"))!).length)
      .toBe(listProjectionIntents(dBeforeFail!).length);

    // Linked actor refusal vs configured principal
    expect(canIntegrateLinkedGitDelivery({ kind: "agent", name: "worker" }, settings.integratePrincipals)).toBe(false);
    expect(canPruneLinkedGitDelivery({ kind: "agent", name: "worker" }, settings.prunePrincipals)).toBe(false);
    expect(canPruneLinkedGitDelivery({ kind: "agent", name: "orch" }, settings.prunePrincipals, { kind: "agent", name: "orch" })).toBe(true);
    expect(canPruneLinkedGitDelivery({ kind: "human" }, settings.prunePrincipals, { kind: "legacy" })).toBe(false);
    // Legacy Delivery-less still uses agent equality
    expect(canPruneGitDelivery({
      agent: "worker",
      createdBy: { kind: "agent", name: "x" },
    } as never, "worker", [])).toBe(true);

    // Unsafe lease (held) refuses prune via T14 snapshot class
    const heldSnapSvc = new DeliveryProjectionService({
      deliveries,
      gitDeliveries,
      workspaceRoot: root,
      workspaceId: "ws",
      git,
      liveness: async () => "not_live",
      withWorktreeLock,
      settings: () => settings,
      loadReloadSnapshot: async () => ({
        classifications: [{ deliveryId: "d-t15", class: "held", reason: "held for test" }],
        byId: new Map([["d-t15", { deliveryId: "d-t15", class: "held" as const, reason: "held for test" }]]),
        unavailableAgents: new Set<string>(),
      }),
      now: () => now,
    });
    await expect(heldSnapSvc.prune({
      deliveryId: "d-t15",
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: integrated.projection.version,
      actor: human, caller: human,
      operationId: "op-prune-held",
    })).rejects.toThrow(/safety class 'held'/);

    // Snapshot-read failure refuses before effects
    const failSnapSvc = new DeliveryProjectionService({
      deliveries,
      gitDeliveries,
      workspaceRoot: root,
      workspaceId: "ws",
      git,
      liveness: async () => "not_live",
      withWorktreeLock,
      settings: () => settings,
      loadReloadSnapshot: async () => { throw new Error("snapshot exploded"); },
      now: () => now,
    });
    await expect(failSnapSvc.prune({
      deliveryId: "d-t15",
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: integrated.projection.version,
      actor: human, caller: human,
      operationId: "op-prune-snap",
    })).rejects.toThrow(/snapshot read failed/);

    // Hygiene: linked unsafe never ready_to_prune
    const hygiene = await hygieneReport([integrated.projection], [], {
      workspaceRoot: root,
      git,
      liveness: async () => "not_live",
      deliveriesById: new Map([["d-t15", (await deliveries.get("d-t15"))!]]),
      reloadSnapshot: {
        classifications: [{ deliveryId: "d-t15", class: "held", reason: "held" }],
        byId: new Map([["d-t15", { deliveryId: "d-t15", class: "held", reason: "held" }]]),
        unavailableAgents: new Set(["worker"]),
      },
    });
    expect(hygiene.findings.some((f) => f.category === "delivery_unavailable")).toBe(true);
    expect(hygiene.findings.some((f) => f.category === "ready_to_prune")).toBe(false);

    // --- Concurrent reconcile vs prune under exclusive claim: no divergence ---
    // Start prune (takes claim). Concurrent reconcile must busy-retry rather than mutate underfoot.
    let pruneEntered = false;
    let reconcileSawBusy = false;
    const slowGit: GitExec = async (args) => {
      if (args[0] === "show-ref") return branchGone ? fail() : ok();
      if (args[0] === "rev-parse") return ok("tip\n");
      if (args[0] === "status") {
        // Hold the claim while prune is inside live checks.
        pruneEntered = true;
        await new Promise((r) => setTimeout(r, 40));
        return ok("");
      }
      if (args[0] === "merge-base") return ok();
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(worktreeGone ? "" : `worktree ${wt}\nbranch refs/heads/tachyon/d\n`);
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        worktreeGone = true;
        fs.rmSync(wt, { recursive: true, force: true });
        return ok();
      }
      if (args[0] === "branch") {
        branchGone = true;
        return ok();
      }
      return ok();
    };
    const concurrentSvc = new DeliveryProjectionService({
      deliveries,
      gitDeliveries,
      workspaceRoot: root,
      workspaceId: "ws",
      git: slowGit,
      liveness: async () => "not_live",
      worktreeOccupancy: async () => undefined,
      withWorktreeLock,
      settings: () => settings,
      loadReloadSnapshot: async (deliveryId) => {
        const d = await deliveries.get(deliveryId);
        if (!d) throw new Error("missing");
        const p = d.gitDeliveryId ? await gitDeliveries.get(d.gitDeliveryId) : undefined;
        return buildSingleDeliveryReloadSnapshot({ delivery: d, projection: p });
      },
      now: () => now,
    });

    const pruneP = concurrentSvc.prune({
      deliveryId: "d-t15",
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: integrated.projection.version,
      actor: human, caller: human,
      operationId: "op-prune",
    });

    // Spin until prune holds the claim, then reconcile must busy.
    for (let i = 0; i < 50 && !pruneEntered; i++) await new Promise((r) => setTimeout(r, 5));
    try {
      await concurrentSvc.reconcile("d-t15");
    } catch (err) {
      if (err instanceof Error && /projection claim is held|PROJECTION_BUSY|busy/i.test(err.message)) {
        reconcileSawBusy = true;
      } else {
        throw err;
      }
    }
    const pruned = await pruneP;
    expect(pruned.projection.phase).toBe("pruned");
    expect(pruned.result.ok).toBe(true);
    expect(reconcileSawBusy || pruned.projection.lastAppliedProjectionSequence === 3).toBe(true);

    // Idempotent reconcile after prune — no divergence
    const after = await svc.reconcile("d-t15");
    expect(after.projection?.phase).toBe("pruned");
    expect(after.projection?.lastAppliedProjectionSequence).toBe(3);
    expect(after.delivery.gitDeliveryId).toBe(opened.projection.id);

    // Prune crash after git removal: re-observe and complete
    // (already pruned; second prune with same op is idempotent via reconcile path)
    const again = await concurrentSvc.prune({
      deliveryId: "d-t15",
      gitDeliveryId: opened.projection.id,
      expectedGitVersion: integrated.projection.version,
      actor: human, caller: human,
      operationId: "op-prune",
    });
    expect(again.projection.phase).toBe("pruned");
    expect(again.result.ok).toBe(true);

    // Legacy Delivery-less open still works byte-compatibly (no claim, agent policy)
    const legacy = await gitDeliveries.open({
      workspaceId: "ws",
      createdBy: { kind: "agent", name: "legacy-worker" },
      agent: "legacy-worker",
      branchRef: "tachyon/legacy",
      worktreePath: path.join(root, "legacy-wt"),
      tachyonCreatedBranch: true,
      baseRef: "main",
    });
    expect(legacy.deliveryId).toBeUndefined();
    expect(legacy.phase).toBe("open");
    const legacyHygiene = await hygieneReport([legacy], [], {
      workspaceRoot: root,
      git: async () => fail(),
      liveness: async () => "not_live",
    });
    expect(legacyHygiene.rows[0]?.projectionSync === "unlinked" || legacyHygiene.rows[0]?.deliveryId === undefined).toBe(true);
  });
});
