import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyLegacyImport, previewLegacyImport } from "../../src/delivery/legacyImport.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { DelegationRecord } from "../../src/bridge/delegationRecord.js";
import type { GitDelivery } from "../../src/git-delivery/types.js";

describe("container-generated delegation behavior", () => {
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
