import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EngineControlClient } from "../../src/engine-service/controlClient.js";
import type { EngineServiceIdentityV1, EngineShellHelloV1, WorkspaceEventV1 } from "../../src/engine-service/protocol.js";
import { TmuxService, workspaceHash } from "../../src/tmux/TmuxService.js";
import { blankCommandFields } from "../../src/webview/command-studio-shell/domain.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("daemon engine service", () => {
  it("owns a real Workspace and direct Bridge across shell replacement and no-shell time", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-engine-service-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const storageRoot = path.join(root, "storage");
    const mediaRoot = path.join(root, "bundle");
    const runtimeRoot = path.join(root, "runtime");
    for (const directory of [workspaceRoot, storageRoot, mediaRoot, runtimeRoot]) {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    const configPath = path.join(workspaceRoot, "tachyon.yml");
    fs.writeFileSync(configPath, config("worker"), "utf8");
    const socketPath = path.join(runtimeRoot, "engine.sock");
    const viteNode = path.join(process.cwd(), "node_modules/vite-node/vite-node.mjs");
    const worker = path.join(process.cwd(), "test/fixtures/daemonEngineServiceWorker.ts");
    const child = spawn(process.execPath, [viteNode, worker, workspaceRoot, storageRoot, mediaRoot, socketPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const identity = await readReady(child);
    expect(identity).toMatchObject({
      pid: child.pid,
      workspaceRoot: fs.realpathSync(workspaceRoot),
      workspaceHash: workspaceHash(fs.realpathSync(workspaceRoot)),
      bridge: { port: expect.any(Number), instanceId: expect.any(String) },
    });
    expect(identity.processStartIdentity).toMatch(/^linux:[0-9a-f-]+:\d+$/);
    await expectLoopbackListener(identity.bridge.port);

    const first = new EngineControlClient({ socketPath, hello: hello(identity, "shell-old") });
    const firstSession = await first.attach();
    const initial = await first.snapshot();
    expect(initial.projections).toMatchObject({
      workspace: { root: identity.workspaceRoot, hash: identity.workspaceHash, configValid: true },
      bridge: { port: identity.bridge.port, instanceId: identity.bridge.instanceId, direct: true },
      agents: { total: 1, truncated: false, items: [{ name: "worker", declared: true, running: false }] },
    });

    const beforeInvalidStudio = fs.readFileSync(configPath, "utf8");
    const invalidStudio = await first.invoke("operation-studio-invalid-0001", {
      schemaVersion: 1,
      method: "studio.submit",
      input: { state: { ...blankCommandFields(), name: "", cmd: "npm test" } },
    });
    expect(invalidStudio).toMatchObject({ method: "studio.submit", status: "ok", truncated: false });
    if (invalidStudio.method !== "studio.submit" || invalidStudio.status !== "ok") throw new Error("unexpected Studio result");
    expect(invalidStudio.errors).toEqual([expect.stringMatching(/name/i)]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(beforeInvalidStudio);

    const createStudioCommand = {
      schemaVersion: 1 as const,
      method: "studio.submit" as const,
      input: { state: { ...blankCommandFields(), name: "lint", cmd: "npm run lint" } },
    };
    const createdStudio = await first.invoke("operation-studio-create-0001", createStudioCommand);
    expect(createdStudio).toEqual({ schemaVersion: 1, method: "studio.submit", status: "ok", errors: [], truncated: false });
    expect(await first.invoke("operation-studio-create-0001", createStudioCommand)).toEqual(createdStudio);
    expect(fs.readFileSync(configPath, "utf8")).toContain("lint:");
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "commands");

    const startCommand = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "worker" } };
    const started = await first.invoke("operation-engine-start-0001", startCommand);
    expect(started).toEqual({ schemaVersion: 1, method: "agent.start", status: "ok" });
    expect(await first.invoke("operation-engine-start-0001", startCommand)).toEqual(started);
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: true }] } },
    });
    expect(await first.invoke("operation-engine-kill-0001", {
      schemaVersion: 1,
      method: "agent.kill",
      input: { agent: "worker" },
    })).toMatchObject({ status: "ok", method: "agent.kill" });
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: false }] } },
    });

    // Model Extension Host replacement: the old shell disappears without owning any engine teardown.
    const replacement = new EngineControlClient({ socketPath, hello: hello(identity, "shell-new") });
    const replacementSession = await replacement.attach();
    expect(replacementSession.engine).toEqual(firstSession.engine);
    expect((await replacement.health()).shellCount).toBe(2);
    expect(child.exitCode).toBeNull();

    // The Node watcher and event journal remain operational while shell generations are independent.
    fs.writeFileSync(configPath, config("worker", "observer"), "utf8");
    const changed = await waitForEvent(replacement, (event) =>
      event.kind === "views-changed" && event.payload.view === "commands");
    expect(changed.seq).toBeGreaterThan(initial.seq);
    const refreshed = await replacement.snapshot();
    expect(refreshed.projections.agents).toMatchObject({
      total: 2,
      items: [{ name: "observer" }, { name: "worker" }],
    });

    await first.detach();
    await replacement.detach();
    expect((await replacement.health()).shellCount).toBe(0);
    await expectLoopbackListener(identity.bridge.port);
    expect(child.exitCode).toBeNull();

    await stopChild(child);
    expect(child.exitCode).toBe(0);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(await new TmuxService().hasSession(`tachyon-ctl-${identity.workspaceHash}`)).toBe(false);
  }, 20_000);
});

function config(...agents: string[]): string {
  return `agents:\n${agents.map((name) => `  ${name}:\n    cmd: sh\n    autostart: false\n`).join("")}`;
}

function hello(identity: EngineServiceIdentityV1, shellId: string): EngineShellHelloV1 {
  return {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: identity.workspaceRoot,
    workspaceHash: identity.workspaceHash,
    shell: { id: shellId, version: "0.57.0-test", locale: "en" },
    protocol: { min: 1, max: 1 },
    capabilities: [],
    settingsDigest: createHash("sha256").update("settings").digest("hex"),
  };
}

function readReady(child: ChildProcessWithoutNullStreams): Promise<EngineServiceIdentityV1> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => reject(new Error(`daemon engine readiness timeout: ${errors}`)), 10_000);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`daemon engine exited before ready (${code ?? signal}): ${errors}`));
    };
    child.once("close", onClose);
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.startsWith("TACHYON_ENGINE_READY ")) continue;
        clearTimeout(timer);
        child.removeListener("close", onClose);
        resolve(JSON.parse(line.slice("TACHYON_ENGINE_READY ".length)) as EngineServiceIdentityV1);
        return;
      }
    });
  });
}

async function waitForEvent(
  client: EngineControlClient,
  predicate: (event: WorkspaceEventV1) => boolean,
): Promise<WorkspaceEventV1> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const batch = await client.events();
    const found = batch.events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("daemon engine event timed out");
}

function expectLoopbackListener(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Bridge listener ${port} timed out`));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
