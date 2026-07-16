import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { EngineControlClient } from "../../src/engine-service/controlClient.js";
import { startEngineControlServer, type RunningEngineControlServer } from "../../src/engine-service/controlServer.js";
import { EngineEventJournal } from "../../src/engine-service/eventJournal.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";
import {
  workspaceCommandSuccessV1,
  workspaceExtensionCommandSuccessV1,
  workspaceExtensionQuerySuccessV1,
  workspaceHandoffViewSuccessV1,
  workspaceMissionControlViewSuccessV1,
  workspacePinStudioViewSuccessV1,
  workspaceProbeViewSuccessV1,
  workspaceSidebarViewSuccessV1,
  workspaceTaskDetailViewSuccessV1,
  workspaceTaskStudioViewSuccessV1,
  type EngineServiceIdentityV1,
  type EngineShellHelloV1,
} from "../../src/engine-service/protocol.js";

const roots: string[] = [];
const servers: RunningEngineControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = makeSocketTemp("tachyon-engine-client-");
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
  const hello: EngineShellHelloV1 = {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: root,
    workspaceHash: identity.workspaceHash,
    shell: { id: "shell-0001", version: "0.57.0", locale: "pt-BR" },
    protocol: { min: 1, max: 1 },
    capabilities: ["editor.diff"],
    settingsDigest: createHash("sha256").update("settings").digest("hex"),
  };
  return {
    root,
    socketPath: path.join(runtime, "engine.sock"),
    identity,
    hello,
    snapshot: () => ({ schemaVersion: 1 as const, engineInstanceId: identity.instanceId, seq, projections: { agents: [] } }),
    setSeq: (next: number) => { seq = next; },
  };
}

describe("EngineControlClient", () => {
  it("attaches, resnapshots and detaches without owning engine lifecycle", async () => {
    const f = fixture();
    const server = await startEngineControlServer({ socketPath: f.socketPath, identity: f.identity, getSnapshot: f.snapshot });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    expect((await client.health()).engine.instanceId).toBe(f.identity.instanceId);
    expect((await client.attach()).snapshotSeq).toBe(7);
    f.setSeq(8);
    expect(await client.snapshot()).toMatchObject({ seq: 8, projections: { agents: [] } });
    expect((await client.touch()).snapshotSeq).toBe(8);
    await client.detach();
    expect(client.attached).toBe(false);
    expect((await client.health()).shellCount).toBe(0);
  });

  it("fails closed when a snapshot sequence moves backwards", async () => {
    const f = fixture();
    const server = await startEngineControlServer({ socketPath: f.socketPath, identity: f.identity, getSnapshot: f.snapshot });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    f.setSeq(6);
    await expect(client.snapshot()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("forgets an expired remote lease and requires a fresh attach", async () => {
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
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    now += 101;
    await expect(client.snapshot()).rejects.toMatchObject({
      code: "REMOTE",
      remoteCode: "SHELL_SESSION_INVALID",
    });
    expect(client.attached).toBe(false);
    await expect(client.touch()).rejects.toMatchObject({ code: "NOT_ATTACHED" });
  });

  it("rejects a local service response that does not match the versioned protocol", async () => {
    const f = fixture();
    const connections = new Set<net.Socket>();
    const malformed = net.createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      socket.end('{"ok":true}\n');
    });
    await new Promise<void>((resolve, reject) => {
      malformed.once("error", reject);
      malformed.listen(f.socketPath, resolve);
    });
    try {
      const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
      await expect(client.health()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    } finally {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => malformed.close(() => resolve()));
      try { fs.unlinkSync(f.socketPath); } catch { /* already removed by Node */ }
    }
  });

  it("streams contiguous events and requests a full snapshot after journal compaction", async () => {
    const f = fixture();
    const journal = new EngineEventJournal({
      filePath: path.join(f.root, "events", "engine.jsonl"),
      engineInstanceId: f.identity.instanceId,
      maxEvents: 2,
    });
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: () => ({
        schemaVersion: 1,
        engineInstanceId: f.identity.instanceId,
        seq: journal.latestSeq,
        projections: { agents: [] },
      }),
      readEvents: (afterSeq, limit) => journal.readAfter(afterSeq, limit),
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    journal.append("one", {});
    journal.append("two", {});
    journal.append("three", {});
    expect(await client.events()).toMatchObject({ resyncRequired: true, oldestSeq: 2, latestSeq: 3, events: [] });
    expect((await client.snapshot()).seq).toBe(3);
    journal.append("four", { view: "agents" });
    expect(await client.events()).toMatchObject({
      resyncRequired: false,
      events: [{ seq: 4, kind: "four", payload: { view: "agents" } }],
    });
  });

  it("binds an authenticated Probe query response to the requested caller", async () => {
    const f = fixture();
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query) => {
        if (query.method !== "probe.view") throw new Error("unexpected query");
        return workspaceProbeViewSuccessV1({
          rows: [],
          total: 0,
          running: 0,
          completed: 0,
          failed: 0,
          empty: true,
          caller: query.input.caller === "mismatch" ? "other" : query.input.caller,
        });
      },
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    expect(await client.query({ schemaVersion: 1, method: "probe.view", input: { caller: "codex" } }))
      .toMatchObject({ status: "ok", view: { caller: "codex", empty: true } });
    expect(await client.query({ schemaVersion: 1, method: "probe.view", input: { caller: "mismatch" } }))
      .toMatchObject({ status: "error", code: "INVALID_QUERY_RESULT" });
  });

  it("allows the dedicated bounded board envelope without relaxing ordinary control responses", async () => {
    const f = fixture();
    const views = Array.from({ length: 20 }, (_, index) => ({
      task: {
        id: `t-${index.toString(16).padStart(6, "0")}`,
        title: `task ${index}`,
        body: "x".repeat(4_000),
        status: "inbox" as const,
        author: "human",
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:00:00.000Z",
      },
    }));
    const result = workspaceMissionControlViewSuccessV1({
      schemaVersion: 1,
      board: {
        schemaVersion: 1,
        views,
        allowedDropStatuses: Object.fromEntries(views.map((view) => [view.task.id, ["triaged", "dropped"]])),
        chips: [],
      },
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, op: "query", result }), "utf8")).toBeGreaterThan(64 * 1024);
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query) => {
        if (query.method !== "task.board") throw new Error("unexpected query");
        return result;
      },
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    expect(await client.query({ schemaVersion: 1, method: "task.board", input: { liveAdhocAgents: [] } }))
      .toMatchObject({
        method: "task.board",
        status: "ok",
        view: { board: { views: expect.arrayContaining([expect.objectContaining({ task: expect.objectContaining({ id: "t-000000" }) })]) } },
      });
  });

  it("allows the dedicated Task Detail envelope above the ordinary 64 KiB response limit", async () => {
    const f = fixture();
    const result = workspaceTaskDetailViewSuccessV1({
      schemaVersion: 1,
      detail: {
        schemaVersion: 1,
        task: {
          id: "t-abc123",
          title: "large journal",
          status: "inbox",
          author: "human",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        },
        journal: Array.from({ length: 20 }, (_, index) => ({
          id: `j-${index.toString(16).padStart(12, "0")}`,
          ts: "2026-07-14T12:00:00.000Z",
          author: "codex",
          text: "x".repeat(4_000),
        })),
        deps: [],
        imageAttachments: [],
        prototypes: { readOnly: false, prototypes: [] },
      },
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, op: "query", result }), "utf8")).toBeGreaterThan(64 * 1024);
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query) => {
        if (query.method !== "task.detail") throw new Error("unexpected query");
        return result;
      },
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    expect(await client.query({ schemaVersion: 1, method: "task.detail", input: { id: "t-abc123" } }))
      .toMatchObject({ method: "task.detail", status: "ok", view: { detail: { journal: expect.arrayContaining([
        expect.objectContaining({ id: "j-000000000000" }),
      ]) } } });
  });

  it("allows the dedicated Task Studio envelope above the ordinary 64 KiB response limit", async () => {
    const f = fixture();
    const result = workspaceTaskStudioViewSuccessV1({
      schemaVersion: 1,
      studio: {
        schemaVersion: 1,
        taskId: "t-abc123",
        title: "large Task Studio document",
        deps: [],
        artifact_refs: [],
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(80_000) }] }] },
        attachments: [],
        anchor: "load",
        prototypes: { readOnly: false, prototypes: [] },
      },
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, op: "query", result }), "utf8")).toBeGreaterThan(64 * 1024);
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query) => {
        if (query.method !== "task.studio") throw new Error("unexpected query");
        return result;
      },
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    expect(await client.query({ schemaVersion: 1, method: "task.studio", input: { id: "t-abc123" } }))
      .toMatchObject({ method: "task.studio", status: "ok", view: { studio: { taskId: "t-abc123" } } });
  });

  it("allows the dedicated Pin Studio envelope above the ordinary 64 KiB response limit", async () => {
    const f = fixture();
    const result = workspacePinStudioViewSuccessV1({
      schemaVersion: 1,
      studio: {
        schemaVersion: 1,
        pinId: "p-abc123",
        title: "x".repeat(80_000),
        tags: [],
        doc: { type: "doc", content: [{ type: "paragraph" }] },
        attachments: [],
      },
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, op: "query", result }), "utf8")).toBeGreaterThan(64 * 1024);
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query) => {
        if (query.method !== "pin.studio") throw new Error("unexpected query");
        return result;
      },
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    expect(await client.query({ schemaVersion: 1, method: "pin.studio", input: { id: "p-abc123" } }))
      .toMatchObject({ method: "pin.studio", status: "ok", view: { studio: { pinId: "p-abc123" } } });
  });

  it("allows the dedicated Project Handoff envelope above the ordinary 64 KiB response limit", async () => {
    const f = fixture();
    const result = workspaceHandoffViewSuccessV1({
      schemaVersion: 1,
      handoff: {
        canonicalRelativePath: ".tachyon/HANDOFF.md",
        exists: true,
        body: "x".repeat(80_000),
        staleness: "fresh",
        pendingCount: 0,
        updatedAt: "2026-07-14T12:00:00.000Z",
        updatedBy: "human",
        revision: "0123456789abcdef",
        notes: [],
        distillTargets: [],
      },
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, op: "query", result }), "utf8")).toBeGreaterThan(64 * 1024);
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query) => {
        if (query.method !== "handoff.view") throw new Error("unexpected query");
        return result;
      },
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    expect(await client.query({ schemaVersion: 1, method: "handoff.view", input: {} }))
      .toMatchObject({ method: "handoff.view", status: "ok", view: { handoff: { exists: true } } });
  });

  it("allows the dedicated Sidebar envelope above the ordinary 64 KiB response limit", async () => {
    const f = fixture();
    const result = workspaceSidebarViewSuccessV1({
      schemaVersion: 1,
      fleet: {
        folder: { hash: f.identity.workspaceHash, name: "workspace" },
        bridge: { port: String(f.identity.bridge.port), connected: true },
        agents: [],
        terminals: [],
        commands: [],
        runbooks: [],
        pins: Array.from({ length: 40 }, (_, index) => ({
          id: `p-${index.toString(16).padStart(6, "0")}`,
          text: `pin-${index}-${"x".repeat(1_990)}`,
          done: false,
          by: "human",
          tags: [],
        })),
        schedules: [],
        pipelines: [],
        proposals: [],
        handoff: { exists: false, staleness: "fresh", pendingCount: 0 },
      },
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, op: "query", result }), "utf8")).toBeGreaterThan(64 * 1024);
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query) => {
        if (query.method !== "sidebar.view") throw new Error("unexpected query");
        return result;
      },
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    expect(await client.query({ schemaVersion: 1, method: "sidebar.view", input: {} }))
      .toMatchObject({ method: "sidebar.view", status: "ok", view: { fleet: { pins: expect.arrayContaining([
        expect.objectContaining({ id: "p-000000" }),
      ]) } } });
  });

  it("allows bounded extension query and command envelopes above the ordinary 64 KiB limit", async () => {
    const f = fixture();
    const large = `payload-${"x".repeat(80_000)}`;
    const server = await startEngineControlServer({
      socketPath: f.socketPath,
      identity: f.identity,
      getSnapshot: f.snapshot,
      query: async (query) => {
        if (query.method !== "extension.query") throw new Error("unexpected query");
        return workspaceExtensionQuerySuccessV1(query, large);
      },
      invoke: async (command) => {
        if (command.method !== "extension.invoke") throw new Error("unexpected command");
        return workspaceExtensionCommandSuccessV1(command, large);
      },
    });
    servers.push(server);
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    await expect(client.query({ schemaVersion: 1, method: "extension.query", input: { action: "agents.list" } }))
      .resolves.toMatchObject({ status: "ok", action: "agents.list", value: large });
    await expect(client.invoke("operation-extension-large-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "command.tick" },
    })).resolves.toMatchObject({ status: "ok", action: "command.tick", value: large });
  });

  it("invokes an operation by exact id without transport-level retries", async () => {
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
    const client = new EngineControlClient({ socketPath: f.socketPath, hello: f.hello });
    await client.attach();
    const command = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "worker" } };
    const first = await client.invoke("operation-client-0001", command);
    expect(first).toEqual({ schemaVersion: 1, method: "agent.start", status: "ok" });
    expect(await client.invoke("operation-client-0001", command)).toEqual(first);
    expect(executions).toBe(1);
  });
});
