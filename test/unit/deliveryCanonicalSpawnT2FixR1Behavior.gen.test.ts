import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GitDeliveryStore } from "../../src/git-delivery/store.js";

describe("container-generated delegation behavior", () => {
  it("observes real cross-process SQLite busy contention without timing sleeps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-canonical-busy-"));
    const worker = path.join(root, "locker.cjs");
    fs.writeFileSync(worker, `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[2], { timeout: 0 });
      db.exec("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY)");
      try {
        db.exec("BEGIN IMMEDIATE");
        process.send("locked");
        process.once("message", () => { db.exec("COMMIT"); db.close(); process.exit(0); });
      } catch (error) { process.send({ busy: error.code === "ERR_SQLITE_ERROR", message: error.message }); db.close(); process.exit(0); }
    `);
    const dbPath = path.join(root, "probe.sqlite3");
    const start = () => fork(worker, [dbPath], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const message = (child: ReturnType<typeof start>) => new Promise<unknown>((resolve, reject) => {
      child.once("message", resolve); child.once("error", reject);
    });
    try {
      const holder = start();
      expect(await message(holder)).toBe("locked");
      const contender = start();
      expect(await message(contender)).toMatchObject({ busy: true });
      holder.send("commit");
      await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
      const successor = start();
      expect(await message(successor)).toBe("locked");
      successor.send("commit");
      await new Promise<void>((resolve) => successor.once("exit", () => resolve()));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
