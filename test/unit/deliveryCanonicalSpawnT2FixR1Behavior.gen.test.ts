import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GitDeliveryStore } from "../../src/git-delivery/store.js";

describe("container-generated delegation behavior", () => {
  it("reconciles concurrent GitDeliveryStore.open calls from real subprocesses", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-canonical-busy-"));
    const worker = path.join(root, "open-worker.ts");
    fs.writeFileSync(worker, `
      import { GitDeliveryStore } from ${JSON.stringify(path.join(process.cwd(), "src/git-delivery/store.ts"))};
      const root = process.argv[2];
      process.stdout.write("ready\\n");
      process.stdin.once("data", async () => {
        const input = { workspaceId: "ws", createdBy: { kind: "agent", name: "coordinator" }, deliveryId: "d-spawn",
          agent: "worker", branchRef: "tachyon/worker", worktreePath: root + "/worker", tachyonCreatedBranch: true, baseRef: "main" };
        for (let attempt = 0; attempt < 20; attempt++) {
          try { process.stdout.write(JSON.stringify(await new GitDeliveryStore(root).open(input)) + "\\n"); return; }
          catch (error) {
            if (!/busy|locked/i.test(String(error)) || attempt === 19) {
              process.stdout.write(JSON.stringify({ error: String(error) }) + "\\n"); return;
            }
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      });
    `);
    const viteNode = path.join(process.cwd(), "node_modules/vite-node/vite-node.mjs");
    const start = () => spawn(process.execPath, [viteNode, worker, root], { stdio: ["pipe", "pipe", "inherit"] });
    const line = (child: ReturnType<typeof start>) => new Promise<string>((resolve, reject) => {
      child.stdout.once("data", (data) => resolve(String(data).trim())); child.once("error", reject);
    });
    const closed = (child: ReturnType<typeof start>) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const left = start(); const right = start();
    const leftClosed = closed(left); const rightClosed = closed(right);
    try {
      expect(await line(left)).toBe("ready"); expect(await line(right)).toBe("ready");
      const leftResult = line(left); const rightResult = line(right);
      left.stdin.end("go\\n"); right.stdin.end("go\\n");
      const results = [JSON.parse(await leftResult), JSON.parse(await rightResult)];
      expect(results[0].id).toBe(results[1].id);
      expect(results.every((record) => record.deliveryId === "d-spawn" && record.agent === "worker")).toBe(true);
      const active = (await new GitDeliveryStore(root).list()).filter((record) => record.phase !== "pruned");
      expect(active).toHaveLength(1);
      expect(await new GitDeliveryStore(root).get(results[0].id)).toMatchObject({ deliveryId: "d-spawn", branchRef: "tachyon/worker" });
      expect(await Promise.all([leftClosed, rightClosed])).toEqual([
        { code: 0, signal: null },
        { code: 0, signal: null },
      ]);
    } finally {
      if (!left.stdin.destroyed) left.stdin.end();
      if (!right.stdin.destroyed) right.stdin.end();
      if (left.exitCode === null && left.signalCode === null) left.kill();
      if (right.exitCode === null && right.signalCode === null) right.kill();
      await Promise.all([leftClosed, rightClosed]);
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
        new GitDeliveryStore(root).open(input),
        new GitDeliveryStore(root).open(input),
      ]);
      expect(left.id).toBe(right.id);
      expect(left.deliveryId).toBe("d-spawn-canonical");
      expect(right.deliveryId).toBe("d-spawn-canonical");
      const active = (await new GitDeliveryStore(root).list()).filter((record) => record.phase !== "pruned");
      expect(active).toHaveLength(1);
      expect(active[0].deliveryId).toBe("d-spawn-canonical");

      await expect(new GitDeliveryStore(root).open({ ...input, deliveryId: "d-conflict" }))
        .rejects.toThrow(/expected deterministic id|linked to Delivery|conflicting delivery|immutable open intent/);
      expect(await new GitDeliveryStore(root).list()).toEqual(active);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
