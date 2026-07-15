import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyLegacyImport, previewLegacyImport } from "../../src/delivery/legacyImport.js";
import { DeliveryStore, DeliveryStoreBusyError } from "../../src/delivery/store.js";
import type { DelegationRecord } from "../../src/bridge/delegationRecord.js";
import type { GitDelivery } from "../../src/git-delivery/types.js";
import { GitDeliveryStore } from "../../src/git-delivery/store.js";

describe("container-generated delegation behavior", () => {
  it("converges simultaneous identical applies with distinct transport operation ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-import-concurrent-"));
    const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
    const record: DelegationRecord = { id: "legacy-concurrent", agent: "worker", baseSha: "base", taskRef: "task/concurrent", worktreePath: worktree, owns: ["src/a.ts"], behaviorTest: "same intent", contract: { task: "converge" }, createdAt: "2026-07-10T00:00:00.000Z" };
    const deps = { isAncestor: async () => true, now: () => "2026-07-10T01:00:00.000Z" };
    const git = new GitDeliveryStore(root, { now: deps.now, id: () => "gd-concurrent" });
    await git.open({ workspaceId: "ws", createdBy: { kind: "system" }, agent: record.agent, branchRef: record.taskRef, worktreePath: worktree, tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "base" });
    const preview = await previewLegacyImport({ workspaceId: "ws", record, gitDeliveries: await git.list() }, deps);
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    const delivery = new DeliveryStore(root, { now: deps.now });
    const [left, right] = await Promise.all([
      applyLegacyImport({ workspaceId: "ws", record, fingerprint: preview.fingerprint, operationId: "op-left" }, { delivery, git }, deps),
      applyLegacyImport({ workspaceId: "ws", record, fingerprint: preview.fingerprint, operationId: "op-right" }, { delivery, git }, deps),
    ]);
    expect("id" in left && left.id).toBe(preview.delivery.id);
    expect("id" in right && right.id).toBe(preview.delivery.id);
    expect(await delivery.list()).toHaveLength(1);
    expect(await git.get("gd-concurrent")).toMatchObject({ deliveryId: preview.delivery.id, legacyImport: { state: "linked", deliveryId: preview.delivery.id, intentFingerprint: preview.intentFingerprint } });
  });

  it("bounds retries when legacy-import storage remains busy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-import-busy-"));
    const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
    const record: DelegationRecord = { id: "legacy-busy", agent: "worker", baseSha: "base", taskRef: "task/busy", worktreePath: worktree, owns: ["src/a.ts"], behaviorTest: "bounded contention", contract: { task: "bounded" }, createdAt: "2026-07-10T00:00:00.000Z" };
    const waits: number[] = [];
    const deps = { isAncestor: async () => true, now: () => "2026-07-10T01:00:00.000Z", sleep: async (ms: number) => { waits.push(ms); } };
    const git = new GitDeliveryStore(root, { now: deps.now, id: () => "gd-busy" });
    await git.open({ workspaceId: "ws", createdBy: { kind: "system" }, agent: record.agent, branchRef: record.taskRef, worktreePath: worktree, tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "base" });
    const preview = await previewLegacyImport({ workspaceId: "ws", record, gitDeliveries: await git.list() }, deps);
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    let attempts = 0;
    const blocked = {
      async get() { return undefined; },
      async createLegacyImport() { attempts += 1; throw new DeliveryStoreBusyError("busy.sqlite3"); },
    } as unknown as DeliveryStore;

    await expect(applyLegacyImport({ workspaceId: "ws", record, fingerprint: preview.fingerprint, operationId: "op-busy" }, { delivery: blocked, git }, deps))
      .rejects.toBeInstanceOf(DeliveryStoreBusyError);
    expect(attempts).toBe(4);
    expect(waits).toEqual([0, 10, 50]);
  });

  it("recovers identical legacy intent under a new operation id after create failure and post-create crash", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-import-recovery-"));
    const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
    const record: DelegationRecord = { id: "legacy-recovery", agent: "worker", baseSha: "base", taskRef: "task/recovery", worktreePath: worktree, owns: ["src/a.ts"], behaviorTest: "recover", contract: { task: "recover" }, createdAt: "2026-07-10T00:00:00.000Z" };
    const git: GitDelivery = { schemaVersion: 1, id: "gd-recovery", version: 1, workspaceId: "ws", createdBy: { kind: "system" }, agent: "worker", branchRef: record.taskRef, worktreePath: worktree, tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "base", phase: "open", taskLinks: [], transitions: [], createdAt: record.createdAt, updatedAt: record.createdAt };
    const deps = { isAncestor: async () => true, now: () => "2026-07-10T01:00:00.000Z" };
    const store = new DeliveryStore(root);
    const gitStore = {
      async list() { return [git]; }, async get() { return git; },
      async reserveLegacyImport(input: { operationId: string; deliveryId: string; intentFingerprint: string }) {
        const pending = git.legacyImport as { deliveryId?: string; intentFingerprint?: string; state?: string } | undefined;
        if (pending) return pending.state === "pending" && pending.deliveryId === input.deliveryId && pending.intentFingerprint === input.intentFingerprint
          ? { ok: true as const, projection: git } : { ok: false as const, code: "STALE_PREVIEW" as const };
        Object.assign(git, { version: git.version + 1, legacyImport: { operationId: input.operationId, deliveryId: input.deliveryId, intentFingerprint: input.intentFingerprint, state: "pending" } });
        return { ok: true as const, projection: git };
      },
      async update(_id: string, _version: number, mutate: (value: GitDelivery) => GitDelivery) { Object.assign(git, mutate(git), { version: git.version + 1 }); return git; },
    };
    const preview = await previewLegacyImport({ workspaceId: "ws", record, gitDeliveries: [git] }, deps);
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    const failing = { get: store.get.bind(store), async createLegacyImport() { throw new Error("injected create failure"); } } as unknown as DeliveryStore;
    await expect(applyLegacyImport({ workspaceId: "ws", record, fingerprint: preview.fingerprint, operationId: "op-lost" }, { delivery: failing, git: gitStore }, deps)).rejects.toThrow("injected create failure");
    const recovered = await applyLegacyImport({ workspaceId: "ws", record, fingerprint: preview.fingerprint, operationId: "op-new" }, { delivery: store, git: gitStore }, deps);
    expect("id" in recovered && recovered.id).toBe(preview.delivery.id);

    delete git.deliveryId; Object.assign(git, { version: git.version + 1, legacyImport: { operationId: "op-crashed", deliveryId: preview.delivery.id, intentFingerprint: preview.intentFingerprint, state: "pending" } });
    const postCreate = await applyLegacyImport({ workspaceId: "ws", record, fingerprint: preview.fingerprint, operationId: "op-after-crash" }, { delivery: store, git: gitStore }, deps);
    expect("id" in postCreate && postCreate.id).toBe(preview.delivery.id);
    expect(git.deliveryId).toBe(preview.delivery.id);

    const changed = { ...record, behaviorTest: "different intent" };
    const refused = await applyLegacyImport({ workspaceId: "ws", record: changed, fingerprint: preview.fingerprint, operationId: "op-different" }, { delivery: store, git: gitStore }, deps);
    expect(refused).toMatchObject({ ok: false });
  });

  it("legacy import preserves linear provenance and refuses ambiguous Git projections without mutation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-import-"));
    const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
    const record: DelegationRecord = {
      id: "legacy-1", agent: "implementer", delegator: "orchestrator", taskId: "t-0b5723",
      baseSha: "base", taskRef: "task/legacy", worktreePath: worktree, owns: ["src/a.ts"],
      behaviorTest: "canonical behavior", contract: { task: "migrate" }, createdAt: "2026-07-10T00:00:00.000Z",
      fixerAttempts: [{ occupantAgent: "fixer", requestedOwnsSubset: ["src/a.ts"], grantedAt: "2026-07-10T01:00:00.000Z", branchHeadAtGrant: "implementation" }],
    };
    const projection = (id: string): GitDelivery => ({ schemaVersion: 1, id, version: 1, workspaceId: "ws", createdBy: { kind: "system" }, agent: "implementer", branchRef: "task/legacy", worktreePath: worktree, tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "fixed", phase: "open", taskLinks: [], transitions: [], createdAt: record.createdAt, updatedAt: record.createdAt });
    const deps = { isAncestor: async (a: string, b: string) => `${a}:${b}` === "base:implementation" || `${a}:${b}` === "implementation:fixed", now: () => "2026-07-10T02:00:00.000Z" };
    const store = new DeliveryStore(root);
    const before = await store.list();
    const ambiguous = await previewLegacyImport({ workspaceId: "ws", record, gitDeliveries: [projection("gd-a"), projection("gd-b")] }, deps);
    expect(ambiguous).toMatchObject({ ok: false, code: "AMBIGUOUS_GIT_PROJECTION", candidates: ["gd-a", "gd-b"] });
    expect(await store.list()).toEqual(before);

    const git = projection("gd-one");
    const preview = await previewLegacyImport({ workspaceId: "ws", sourcePath: "legacy.json", record, gitDeliveries: [git] }, deps);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.delivery.segments!.map((s) => ({ role: s.role, grant: s.grantedHeadSha, release: s.releasedHeadSha, owns: s.ownsSubset }))).toEqual([
      { role: "implementer", grant: "base", release: "implementation", owns: ["src/a.ts"] },
      { role: "fixer", grant: "implementation", release: undefined, owns: ["src/a.ts"] },
    ]);
    const gitStore = { async list() { return [git]; }, async get() { return git; }, async reserveLegacyImport(input: { operationId: string; deliveryId: string }) { Object.assign(git, { version: git.version + 1, legacyImport: { operationId: input.operationId, deliveryId: input.deliveryId, state: "pending" } }); return { ok: true as const, projection: git }; }, async update(_id: string, _version: number, mutate: (value: GitDelivery) => GitDelivery) { Object.assign(git, mutate(git), { version: git.version + 1 }); return git; } };
    const applied = await applyLegacyImport({ workspaceId: "ws", sourcePath: "legacy.json", record, gitDeliveries: [projection("gd-one")], fingerprint: preview.fingerprint, operationId: "import-legacy-1" }, { delivery: store, git: gitStore }, deps);
    expect("id" in applied && applied.id).toBe(preview.delivery.id);
    expect(git.deliveryId).toBe(preview.delivery.id);
    expect(await store.list()).toHaveLength(1);

    const racedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-import-race-"));
    const racedDelivery = new DeliveryStore(racedRoot);
    const g1 = projection("gd-race-1");
    const live = [g1];
    let releaseAncestor!: () => void;
    const ancestorEntered = new Promise<void>((resolve) => { releaseAncestor = resolve; });
    let firstAncestor = true;
    const racedDeps = { ...deps, async isAncestor(a: string, b: string) { if (firstAncestor) { firstAncestor = false; releaseAncestor(); await Promise.resolve(); } return deps.isAncestor(a, b); } };
    const racedPreview = await previewLegacyImport({ workspaceId: "ws", sourcePath: "legacy.json", record, gitDeliveries: [g1] }, deps);
    expect(racedPreview.ok).toBe(true);
    if (!racedPreview.ok) return;
    const racedGitStore = {
      async list() { return [...live]; }, async get(id: string) { return live.find((entry) => entry.id === id); },
      async reserveLegacyImport() { const exact = live.filter((entry) => entry.branchRef === record.taskRef && entry.worktreePath === worktree); return exact.length === 1 ? { ok: true as const, projection: exact[0] } : { ok: false as const, code: "AMBIGUOUS_GIT_PROJECTION" as const, candidates: exact.map((entry) => entry.id).sort() }; },
      async update() { throw new Error("must not link after ambiguous reservation"); },
    };
    const racingApply = applyLegacyImport({ workspaceId: "ws", sourcePath: "legacy.json", record, fingerprint: racedPreview.fingerprint, operationId: "import-race" }, { delivery: racedDelivery, git: racedGitStore }, racedDeps);
    await ancestorEntered;
    live.push(projection("gd-race-2"));
    const raced = await racingApply;
    expect(raced).toMatchObject({ ok: false, code: "AMBIGUOUS_GIT_PROJECTION", candidates: ["gd-race-1", "gd-race-2"] });
    expect(await racedDelivery.list()).toEqual([]);

    const nonlinear = await previewLegacyImport({ workspaceId: "ws", record, gitDeliveries: [projection("gd-linear-check")] }, { ...deps, isAncestor: async () => false });
    expect(nonlinear).toMatchObject({ ok: false, code: "NON_LINEAR_HISTORY" });
    expect(await store.list()).toHaveLength(1);
  });
});
