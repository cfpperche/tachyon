import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitDeliveryStore } from "../../src/git-delivery/store.js";

describe("container-generated delegation behavior", () => {
  it("canonical gated spawn never publishes a runtime without one reconciled GitDelivery projection under failure or concurrency", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-canonical-race-"));
    const input = {
      workspaceId: "ws", createdBy: { kind: "agent" as const, name: "coordinator" },
      deliveryId: "d-spawn-canonical", agent: "worker", branchRef: "tachyon/worker",
      worktreePath: path.join(root, "worker"), tachyonCreatedBranch: true, baseRef: "main",
    };
    try {
      // Distinct store instances model distinct extension processes. SQLite, not an in-memory
      // mutex, must choose the winner and make the losing callback observe that same projection.
      const [left, right] = await Promise.all([
        new GitDeliveryStore(root, { id: () => "gd-left" }).open(input),
        new GitDeliveryStore(root, { id: () => "gd-right" }).open(input),
      ]);
      expect(left.id).toBe(right.id);
      expect(left.deliveryId).toBe("d-spawn-canonical");
      expect(right.deliveryId).toBe("d-spawn-canonical");
      const active = (await new GitDeliveryStore(root).list()).filter((record) => record.phase !== "pruned");
      expect(active).toHaveLength(1);
      expect(active[0].deliveryId).toBe("d-spawn-canonical");

      await expect(new GitDeliveryStore(root).open({ ...input, deliveryId: "d-conflict" }))
        .rejects.toThrow(/linked to Delivery|conflicting delivery/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
