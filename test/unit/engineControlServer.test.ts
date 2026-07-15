import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { startEngineControlServer, type RunningEngineControlServer } from "../../src/engine-service/controlServer.js";
import { ENGINE_UI_CAPABILITY } from "../../src/engine-service/uiRequestBroker.js";
import {
  workspaceCommandSuccessV1,
  workspacePinStudioViewSuccessV1,
  workspaceProbeViewSuccessV1,
  type EngineControlRequestV1,
  type EngineControlResponseV1,
  type EngineServiceIdentityV1,
  type EngineShellHelloV1,
} from "../../src/engine-service/protocol.js";
import { blankCommandFields } from "../../src/webview/command-studio-shell/domain.js";

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
    const attachedShells: string[] = [];
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      onShellAttached: (shellId) => attachedShells.push(shellId),
    });
    servers.push(server);

    const first = await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0001") });
    const replay = await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0001") });
    expect(first).toMatchObject({ ok: true, op: "attach", session: { shellId: "shell-0001", snapshotSeq: 7 } });
    expect(attachedToken(replay)).toBe(attachedToken(first));
    expect(server.shellCount()).toBe(1);

    const second = await control(f.socketPath, { schemaVersion: 1, op: "attach", workspaceHash: "abc12345", hello: hello(f.root, "shell-0002") });
    expect(second).toMatchObject({ ok: true, op: "attach", session: { shellId: "shell-0002" } });
    expect(server.shellCount()).toBe(2);
    await waitFor(() => attachedShells.length === 3);
    expect(attachedShells).toEqual(["shell-0001", "shell-0001", "shell-0002"]);

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

  it("routes one operation-id-bound UI request to exactly one capable shell", async () => {
    const f = fixture();
    const server = await startEngineControlServer({ socketPath: f.socketPath, identity: f.identity, getSnapshot: f.snapshot });
    servers.push(server);
    await expect(server.requestUi({ schemaVersion: 1, operationId: "ui-unavailable-0001", kind: "focus-primary" }))
      .rejects.toMatchObject({ code: "UI_UNAVAILABLE" });
    const first = await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-ui-one", { capabilities: [ENGINE_UI_CAPABILITY] }),
    });
    const second = await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-ui-two", { capabilities: [ENGINE_UI_CAPABILITY] }),
    });
    const pending = server.requestUi({
      schemaVersion: 1,
      operationId: "ui-control-0001",
      kind: "execute-command",
      command: "tachyon.doctor",
      args: ["abc12345"],
    });
    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "ui.claim",
      workspaceHash: "abc12345",
      shellId: "shell-ui-one",
      sessionToken: attachedToken(first),
      unexpected: true,
    } as unknown as EngineControlRequestV1)).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "ui.claim",
      workspaceHash: "abc12345",
      shellId: "shell-ui-one",
      sessionToken: attachedToken(first),
    })).toMatchObject({ ok: true, op: "ui.claim", request: { operationId: "ui-control-0001" } });
    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "ui.claim",
      workspaceHash: "abc12345",
      shellId: "shell-ui-two",
      sessionToken: attachedToken(second),
    })).toEqual({ ok: true, op: "ui.claim", request: null });
    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "ui.complete",
      workspaceHash: "abc12345",
      shellId: "shell-ui-two",
      sessionToken: attachedToken(second),
      completion: { schemaVersion: 1, operationId: "ui-control-0001", status: "ok", value: null },
    })).toMatchObject({ ok: false, code: "UI_CLAIM_MISMATCH" });
    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "ui.complete",
      workspaceHash: "abc12345",
      shellId: "shell-ui-one",
      sessionToken: attachedToken(first),
      completion: { schemaVersion: 1, operationId: "ui-control-0001", status: "ok", value: { opened: true } },
    })).toEqual({ ok: true, op: "ui.complete", operationId: "ui-control-0001", completed: true });
    await expect(pending).resolves.toEqual({ opened: true });
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

  it("survives an abrupt shell disconnect while a response is in flight", async () => {
    const f = fixture();
    let releaseSnapshot!: () => void;
    let observeSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const snapshotStarted = new Promise<void>((resolve) => { observeSnapshot = resolve; });
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: async () => {
        observeSnapshot();
        await snapshotGate;
        return {
          ...f.snapshot(),
          projections: { payload: "x".repeat(4 * 1024 * 1024) },
        };
      },
    });
    servers.push(server);

    const abandoned = net.createConnection(f.socketPath);
    await new Promise<void>((resolve, reject) => {
      abandoned.once("connect", resolve);
      abandoned.once("error", reject);
    });
    abandoned.write(`${JSON.stringify({
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-abandoned"),
    })}\n`);
    await snapshotStarted;
    const disconnected = new Promise<void>((resolve) => abandoned.once("close", () => resolve()));
    abandoned.destroy();
    await disconnected;
    releaseSnapshot();

    await expect(control(f.socketPath, {
      schemaVersion: 1,
      op: "health",
      workspaceHash: "abc12345",
    })).resolves.toMatchObject({ ok: true, op: "health", engine: { instanceId: f.identity.instanceId } });
  });

  it("authenticates read-only queries without caching them in the mutation registry", async () => {
    const f = fixture();
    let reads = 0;
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query, context) => {
        reads++;
        expect(context.shellId).toBe("shell-query");
        if (query.method !== "probe.view") throw new Error("unexpected query");
        return workspaceProbeViewSuccessV1({
          rows: [],
          total: 0,
          running: 0,
          completed: 0,
          failed: 0,
          empty: true,
          ...(query.input.caller ? { caller: query.input.caller } : {}),
        });
      },
    });
    servers.push(server);
    const attached = await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-query"),
    });
    const request: EngineControlRequestV1 = {
      schemaVersion: 1,
      op: "query",
      workspaceHash: "abc12345",
      shellId: "shell-query",
      sessionToken: attachedToken(attached),
      query: { schemaVersion: 1, method: "probe.view", input: { caller: "codex" } },
    };
    expect(await control(f.socketPath, request)).toMatchObject({
      ok: true,
      op: "query",
      result: { status: "ok", view: { caller: "codex", empty: true } },
    });
    await control(f.socketPath, request);
    expect(reads).toBe(2);
    expect(await control(f.socketPath, { ...request, sessionToken: "wrong" }))
      .toMatchObject({ ok: false, code: "SHELL_SESSION_INVALID" });
    expect(reads).toBe(2);
  });

  it("refuses a valid query result whose entity identity differs from the request", async () => {
    const f = fixture();
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async () => workspacePinStudioViewSuccessV1({
        schemaVersion: 1,
        studio: {
          schemaVersion: 1,
          pinId: "p-def456",
          title: "wrong pin",
          tags: [],
          doc: null,
          attachments: [],
        },
      }),
    });
    servers.push(server);
    const attached = await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-query-identity"),
    });
    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "query",
      workspaceHash: "abc12345",
      shellId: "shell-query-identity",
      sessionToken: attachedToken(attached),
      query: { schemaVersion: 1, method: "pin.studio", input: { id: "p-abc123" } },
    })).toMatchObject({
      ok: true,
      op: "query",
      result: { status: "error", method: "pin.studio", code: "INVALID_QUERY_RESULT" },
    });
  });

  it("executes one operation once across concurrent shells and binds replay to the exact intent", async () => {
    const f = fixture();
    let executions = 0;
    let release!: () => void;
    let observedStart!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { observedStart = resolve; });
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      invoke: async (command) => {
        executions += 1;
        if (!("agent" in command.input)) throw new Error("unexpected non-agent command");
        if (command.input.agent === "failure") throw new Error("forced command failure");
        observedStart();
        await gate;
        return workspaceCommandSuccessV1(command);
      },
    });
    servers.push(server);
    const firstAttach = await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-0001"),
    });
    const secondAttach = await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-0002"),
    });
    const command = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "worker" } };
    const first = control(f.socketPath, {
      schemaVersion: 1,
      op: "invoke",
      workspaceHash: "abc12345",
      shellId: "shell-0001",
      sessionToken: attachedToken(firstAttach),
      operationId: "operation-shared-0001",
      command,
    });
    await started;
    const replay = control(f.socketPath, {
      schemaVersion: 1,
      op: "invoke",
      workspaceHash: "abc12345",
      shellId: "shell-0002",
      sessionToken: attachedToken(secondAttach),
      operationId: "operation-shared-0001",
      command,
    });
    release();
    const [firstResult, replayResult] = await Promise.all([first, replay]);
    expect(replayResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({ ok: true, op: "invoke", result: { status: "ok" } });
    expect(executions).toBe(1);

    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "invoke",
      workspaceHash: "abc12345",
      shellId: "shell-0002",
      sessionToken: attachedToken(secondAttach),
      operationId: "operation-shared-0001",
      command: { input: { agent: "worker" }, method: "agent.start", schemaVersion: 1 },
    })).toEqual(firstResult);
    expect(executions).toBe(1);

    expect(await control(f.socketPath, {
      schemaVersion: 1,
      op: "invoke",
      workspaceHash: "abc12345",
      shellId: "shell-0002",
      sessionToken: attachedToken(secondAttach),
      operationId: "operation-shared-0001",
      command: { ...command, input: { agent: "other" } },
    })).toMatchObject({
      ok: true,
      op: "invoke",
      result: { status: "error", code: "OPERATION_ID_CONFLICT" },
    });
    expect(executions).toBe(1);

    const failureRequest: EngineControlRequestV1 = {
      schemaVersion: 1,
      op: "invoke",
      workspaceHash: "abc12345",
      shellId: "shell-0001",
      sessionToken: attachedToken(firstAttach),
      operationId: "operation-failure-0001",
      command: { ...command, input: { agent: "failure" } },
    };
    const failure = await control(f.socketPath, failureRequest);
    expect(failure).toMatchObject({ ok: true, op: "invoke", result: { status: "error", code: "COMMAND_FAILED" } });
    expect(await control(f.socketPath, failureRequest)).toEqual(failure);
    expect(executions).toBe(2);

    expect(await control(f.socketPath, { ...failureRequest, operationId: "operation-unauth-0001", sessionToken: "wrong" }))
      .toMatchObject({ ok: false, code: "SHELL_SESSION_INVALID" });
    expect(executions).toBe(2);
  });

  it("canonicalizes the nested Studio intent before idempotency comparison", async () => {
    const f = fixture();
    let executions = 0;
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      invoke: async (command) => {
        executions += 1;
        return workspaceCommandSuccessV1(command);
      },
    });
    servers.push(server);
    const attach = await control(f.socketPath, {
      schemaVersion: 1,
      op: "attach",
      workspaceHash: "abc12345",
      hello: hello(f.root, "shell-studio"),
    });
    const state = { ...blankCommandFields(), name: "lint", cmd: "npm run lint" };
    const request: EngineControlRequestV1 = {
      schemaVersion: 1,
      op: "invoke",
      workspaceHash: "abc12345",
      shellId: "shell-studio",
      sessionToken: attachedToken(attach),
      operationId: "operation-studio-0001",
      command: { schemaVersion: 1, method: "studio.submit", input: { state } },
    };
    const first = await control(f.socketPath, request);
    const reordered = Object.fromEntries(Object.entries(state).reverse()) as typeof state;
    expect(await control(f.socketPath, {
      ...request,
      command: { input: { state: reordered }, method: "studio.submit", schemaVersion: 1 },
    })).toEqual(first);
    expect(executions).toBe(1);
    expect(await control(f.socketPath, {
      ...request,
      command: {
        schemaVersion: 1,
        method: "studio.submit",
        input: { state: { ...state, cmd: "npm run lint -- --fix" } },
      },
    })).toMatchObject({ ok: true, result: { status: "error", code: "OPERATION_ID_CONFLICT" } });
    expect(executions).toBe(1);
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("control server condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
