import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { startEngineControlServer, type RunningEngineControlServer } from "../../src/engine-service/controlServer.js";
import type {
  EngineControlRequestV1,
  EngineControlResponseV1,
  EngineServiceIdentityV1,
  EngineShellHelloV1,
} from "../../src/engine-service/protocol.js";

const roots: string[] = [];
const servers: RunningEngineControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-engine-control-"));
  roots.push(root);
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime, { mode: 0o700 });
  const identity: EngineServiceIdentityV1 = {
    schemaVersion: 1,
    workspaceRoot: fs.realpathSync(root),
    workspaceHash: "abc12345",
    instanceId: "engine-instance-1",
    pid: process.pid,
    processStartIdentity: "proc-start-1",
    startedAt: new Date(0).toISOString(),
    bundleId: "a".repeat(64),
    engineVersion: "0.57.0",
    protocol: { min: 1, max: 1 },
    bridge: { instanceId: "bridge-instance-1", port: 42_897 },
  };
  let seq = 7;
  return {
    root,
    socketPath: path.join(runtime, "engine.sock"),
    identity,
    snapshot: () => ({ schemaVersion: 1 as const, engineInstanceId: identity.instanceId, seq, projections: { agents: [] } }),
    advance: () => { seq++; },
  };
}

function hello(root: string, shellId: string, overrides: Partial<EngineShellHelloV1> = {}): EngineShellHelloV1 {
  return {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: root,
    workspaceHash: "abc12345",
    shell: { id: shellId, version: "0.57.0", locale: "pt-BR" },
    protocol: { min: 1, max: 1 },
    capabilities: ["editor.diff", "ui.notifications"],
    settingsDigest: createHash("sha256").update("settings").digest("hex"),
    ...overrides,
  };
}

describe("persistent engine shell control", () => {
  it("converges duplicate attach and keeps multiple shells independent", async () => {
    const f = fixture();
    const server = await startEngineControlServer({ socketPath: f.socketPath, identity: f.identity, getSnapshot: f.snapshot });
    servers.push(server);

    const first = await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0001") });
    const replay = await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0001") });
    expect(first).toMatchObject({ ok: true, op: "attach", session: { shellId: "shell-0001", snapshotSeq: 7 } });
    expect(attachedToken(replay)).toBe(attachedToken(first));
    expect(server.shellCount()).toBe(1);

    const second = await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0002") });
    expect(second).toMatchObject({ ok: true, op: "attach", session: { shellId: "shell-0002" } });
    expect(server.shellCount()).toBe(2);

    const token = attachedToken(first);
    expect(await control(f.socketPath, { schemaVersion: 1, op: "detach", workspaceHash: "abc12345", shellId: "shell-0001", sessionToken: token }))
      .toEqual({ ok: true, op: "detach", detached: true });
    expect(server.shellCount()).toBe(1);
  });

  it("refuses wrong workspace, incompatible protocol and shell-id identity drift", async () => {
    const f = fixture();
    const server = await startEngineControlServer({ socketPath: f.socketPath, identity: f.identity, getSnapshot: f.snapshot });
    servers.push(server);
    expect(await control(f.socketPath, { schemaVersion: 1, op: "health", workspaceHash: "wrong" }))
      .toMatchObject({ ok: false, code: "WRONG_WORKSPACE" });
    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-0001", { protocol: { min: 2, max: 2 } }),
    })).toMatchObject({ ok: false, code: "PROTOCOL_MISMATCH" });
    await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0001") });
    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-0001", { capabilities: ["editor.diff"] }),
    })).toMatchObject({ ok: false, code: "SHELL_ID_CONFLICT" });
  });

  it("authenticates snapshot/touch and expires abandoned shell leases without engine mutation", async () => {
    const f = fixture();
    let now = 1_000;
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      leaseMs: 100,
      now: () => now,
    });
    servers.push(server);
    const attached = await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0001") });
    const token = attachedToken(attached);
    f.advance();
    expect(await control(f.socketPath, { schemaVersion: 1, op: "snapshot", workspaceHash: "abc12345", shellId: "shell-0001", sessionToken: token }))
      .toMatchObject({ ok: true, op: "snapshot", snapshot: { seq: 8, projections: { agents: [] } } });
    expect(await control(f.socketPath, { schemaVersion: 1, op: "snapshot", workspaceHash: "abc12345", shellId: "shell-0001", sessionToken: "wrong" }))
      .toMatchObject({ ok: false, code: "SHELL_SESSION_INVALID" });
    now += 101;
    expect(await control(f.socketPath, { schemaVersion: 1, op: "touch", workspaceHash: "abc12345", shellId: "shell-0001", sessionToken: token }))
      .toMatchObject({ ok: false, code: "SHELL_SESSION_INVALID" });
    expect(server.shellCount()).toBe(0);
    expect((await control(f.socketPath, { schemaVersion: 1, op: "health", workspaceHash: "abc12345" })))
      .toMatchObject({ ok: true, op: "health", engine: { instanceId: f.identity.instanceId }, shellCount: 0 });
  });

  it("refuses invalid snapshots instead of attaching a shell to ambiguous engine state", async () => {
    const f = fixture();
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: () => ({ schemaVersion: 1, engineInstanceId: "other", seq: 0, projections: {} }),
    });
    servers.push(server);
    expect(await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0001") }))
      .toMatchObject({ ok: false, code: "INTERNAL", message: "engine snapshot violates its identity/sequence contract" });
    expect(server.shellCount()).toBe(0);
  });

  it("does not extend an existing shell lease when resnapshot fails", async () => {
    const f = fixture();
    let now = 1_000;
    let snapshotValid = true;
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: () => snapshotValid ? f.snapshot() : null,
      leaseMs: 100,
      now: () => now,
    });
    servers.push(server);
    const attached = await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0001") });
    const token = attachedToken(attached);
    now = 1_050;
    snapshotValid = false;
    expect(await control(f.socketPath, { schemaVersion: 1, op: "snapshot", workspaceHash: "abc12345", shellId: "shell-0001", sessionToken: token }))
      .toMatchObject({ ok: false, code: "INTERNAL" });
    now = 1_101;
    snapshotValid = true;
    expect(await control(f.socketPath, { schemaVersion: 1, op: "touch", workspaceHash: "abc12345", shellId: "shell-0001", sessionToken: token }))
      .toMatchObject({ ok: false, code: "SHELL_SESSION_INVALID" });
  });

  it("closes without waiting for a shell that connected but never sent a request", async () => {
    const f = fixture();
    const server = await startEngineControlServer({ socketPath: f.socketPath, identity: f.identity, getSnapshot: f.snapshot });
    servers.push(server);
    const idle = net.createConnection(f.socketPath);
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", resolve);
      idle.once("error", reject);
    });
    const disconnected = new Promise<void>((resolve) => idle.once("close", () => resolve()));
    await server.close();
    await disconnected;
    expect(fs.existsSync(f.socketPath)).toBe(false);
  });
});

function attachedToken(response: EngineControlResponseV1): string {
  if (!response.ok || response.op !== "attach") throw new Error("expected attach response");
  return response.session.sessionToken;
}

function control(socketPath: string, request: EngineControlRequestV1): Promise<EngineControlResponseV1> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => { output += chunk; });
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(output) as EngineControlResponseV1));
  });
}
