import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegationRecordFromSpawn, writeDelegationRecord } from "../../src/bridge/delegationRecord.js";
import { verifyTask, VerifyTaskResolutionError } from "../../src/bridge/verifyTask.js";

describe("SDD 368 T4 behavior gate", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  it("verify_task refuses ambiguous same-name legacy delegations instead of selecting by mtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-verify-t4-"));
    roots.push(root);
    const make = (id: string, createdAt: string, taskRef: string) => delegationRecordFromSpawn({
      id,
      agent: "reused-name",
      baseSha: "a".repeat(40),
      taskRef,
      gate: { behaviorTest: "behavior", owns: ["src"] },
      contract: { task: "task", context: "test", constraints: "none", doneWhen: "done" },
      createdAt,
    });
    const oldPath = writeDelegationRecord(root, make("legacy-old", "2026-01-01T00:00:00.000Z", "task/old"));
    const newPath = writeDelegationRecord(root, make("legacy-new", "2026-02-01T00:00:00.000Z", "task/new"));
    // Make the older logical record newest by mtime. Resolution must still refuse both candidates.
    const future = new Date("2030-01-01T00:00:00.000Z");
    fs.utimesSync(oldPath, future, future);
    fs.utimesSync(newPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

    const error = await verifyTask({ workspaceRoot: root, agent: "reused-name" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(VerifyTaskResolutionError);
    expect(error).toMatchObject({
      code: "AMBIGUOUS_LEGACY_DELEGATION",
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: "legacy-old" }),
        expect.objectContaining({ id: "legacy-new" }),
      ]),
    });
  });
});
