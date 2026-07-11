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
    const gitStore = { async get() { return git; }, async update(_id: string, _version: number, mutate: (value: GitDelivery) => GitDelivery) { Object.assign(git, mutate(git), { version: 2 }); return git; } };
    const applied = await applyLegacyImport({ workspaceId: "ws", sourcePath: "legacy.json", record, gitDeliveries: [projection("gd-one")], fingerprint: preview.fingerprint, operationId: "import-legacy-1" }, { delivery: store, git: gitStore }, deps);
    expect("id" in applied && applied.id).toBe(preview.delivery.id);
    expect(git.deliveryId).toBe(preview.delivery.id);
    expect(await store.list()).toHaveLength(1);

    const nonlinear = await previewLegacyImport({ workspaceId: "ws", record, gitDeliveries: [projection("gd-linear-check")] }, { ...deps, isAncestor: async () => false });
    expect(nonlinear).toMatchObject({ ok: false, code: "NON_LINEAR_HISTORY" });
    expect(await store.list()).toHaveLength(1);
  });
});
