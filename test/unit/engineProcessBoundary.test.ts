import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EngineControlClient } from "../../src/engine-service/controlClient.js";
import type { EngineServiceIdentityV1, EngineShellHelloV1 } from "../../src/engine-service/protocol.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persistent engine process boundary", () => {
  it("keeps one engine alive while shell generations disappear and reattach", async () => {
    const root = makeSocketTemp("tachyon-engine-process-");
    roots.push(root);
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime, { mode: 0o700 });
    const socketPath = path.join(runtime, "engine.sock");
    const viteNode = path.join(process.cwd(), "node_modules/vite-node/vite-node.mjs");
    const worker = path.join(process.cwd(), "test/fixtures/engineControlWorker.ts");
    const child = spawn(process.execPath, [viteNode, worker, root, socketPath], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const ready = await readReady(child);
    expect(ready.identity.pid).toBe(child.pid);

    const first = new EngineControlClient({ socketPath, hello: hello(root, "shell-old") });
    const firstSession = await first.attach();
    expect(firstSession.engine).toEqual(ready.identity);

    // Model Extension Host death: discard the first client without detach.  A new shell generation
    // attaches to the same independent process; no engine operation is involved in this transition.
    const replacement = new EngineControlClient({ socketPath, hello: hello(root, "shell-new") });
    const replacementSession = await replacement.attach();
    expect(replacementSession.engine.instanceId).toBe(firstSession.engine.instanceId);
    expect(replacementSession.engine.pid).toBe(child.pid);
    expect((await replacement.health()).shellCount).toBe(2);

    await first.detach();
    await replacement.detach();
    const observer = new EngineControlClient({ socketPath, hello: hello(root, "observer1") });
    const health = await observer.health();
    expect(health).toMatchObject({ engine: { pid: child.pid, instanceId: firstSession.engine.instanceId }, shellCount: 0 });
    expect(child.exitCode).toBeNull();
  });
});

function hello(root: string, shellId: string): EngineShellHelloV1 {
  return {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: root,
    workspaceHash: "process1",
    shell: { id: shellId, version: "0.57.0-test", locale: "en" },
    protocol: { min: 1, max: 1 },
    capabilities: [],
    settingsDigest: createHash("sha256").update("settings").digest("hex"),
  };
}

function readReady(child: ChildProcessWithoutNullStreams): Promise<{ ready: true; identity: EngineServiceIdentityV1 }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => reject(new Error(`engine worker readiness timeout: ${errors}`)), 5_000);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`engine worker exited before ready (${code ?? signal}): ${errors}`));
    };
    child.once("close", onClose);
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(JSON.parse(output.slice(0, newline)) as { ready: true; identity: EngineServiceIdentityV1 });
    });
  });
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
