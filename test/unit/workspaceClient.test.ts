import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEngineControlServer, type RunningEngineControlServer } from "../../src/engine-service/controlServer.js";
import { EngineEventJournal } from "../../src/engine-service/eventJournal.js";
import type { StagedEngineBundle } from "../../src/engine-service/engineBundleStore.js";
import { workspaceCommandSuccessV1, type EngineServiceIdentityV1, type WorkspaceSnapshotEnvelopeV1 } from "../../src/engine-service/protocol.js";
import { connectRemoteWorkspaceClient } from "../../src/shell/WorkspaceClient.js";
import { workspaceHash } from "../../src/tmux/TmuxService.js";

const roots: string[] = [];
const servers: RunningEngineControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("remote WorkspaceClient", () => {
  it("syncs projections, resnapshots gaps, renews an expired lease and audits a real incarnation change", async () => {
    const root = temp("tachyon-workspace-client-");
    const workspaceRoot = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(workspaceRoot, { mode: 0o700 });
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    const socketPath = path.join(runtimeRoot, "control.sock");
    const canonicalRoot = fs.realpathSync(workspaceRoot);
    const firstIdentity = identity(canonicalRoot, "engine-one", "bridge-one");
    let now = 1_000;
    let commandExecutions = 0;
    const firstJournal = new EngineEventJournal({
      filePath: path.join(root, "events-one.jsonl"),
      engineInstanceId: firstIdentity.instanceId,
      maxEvents: 2,
    });
    let firstSnapshot = snapshot(firstIdentity, 0, "initial");
    let currentIdentity = firstIdentity;
    let ensureCalls = 0;
    let currentServer = await startEngineControlServer({
      socketPath,
      identity: firstIdentity,
      getSnapshot: () => firstSnapshot,
      readEvents: (afterSeq, limit) => firstJournal.readAfter(afterSeq, limit),
      invoke: async (command) => {
        commandExecutions += 1;
        return workspaceCommandSuccessV1(command);
      },
      leaseMs: 100,
      now: () => now,
    });
    servers.push(currentServer);

    const client = await connectRemoteWorkspaceClient({
      workspaceRoot,
      bundle: dummyBundle(root),
      shell: { id: "shell-client-one", version: "0.57.0-test", locale: "en" },
      capabilities: ["open-diff"],
      settings: { global: { "tachyon.maxAgents": 4 } },
      ensure: async () => {
        ensureCalls += 1;
        return { identity: currentIdentity, controlSocketPath: socketPath, disposition: "reused-exact" };
      },
    });
    expect(client.identity).toEqual(firstIdentity);
    expect(client.snapshot.projections.marker).toBe("initial");
    expect(client.presentation).toMatchObject({
      workspace: { root: canonicalRoot, hash: firstIdentity.workspaceHash },
      bridge: { instanceId: firstIdentity.bridge.instanceId, port: firstIdentity.bridge.port },
      agents: { total: 0, truncated: false, items: [] },
    });
    expect(client.bridgeUrl).toBe(`http://127.0.0.1:${firstIdentity.bridge.port}/mcp`);
    expect(currentServer.shellCount()).toBe(1);
    expect(ensureCalls).toBe(1);

    const observed: Array<{ resynced: boolean; engineChanged: boolean; marker: unknown }> = [];
    client.subscribe((result) => observed.push({
      resynced: result.resynced,
      engineChanged: result.engineChanged,
      marker: result.snapshot.projections.marker,
    }));

    firstJournal.append("views-changed", { view: "agents" });
    firstSnapshot = snapshot(firstIdentity, firstJournal.latestSeq, "event-one");
    const incremental = await client.sync();
    expect(incremental).toMatchObject({ resynced: false, engineChanged: false });
    expect(incremental.events.map((event) => event.kind)).toEqual(["views-changed"]);
    expect(incremental.snapshot.projections.marker).toBe("event-one");
    expect(ensureCalls).toBe(1);

    // Cursor 1 falls behind a two-record retained tail after seq 4, forcing an honest full resnapshot.
    firstJournal.append("views-changed", { view: "tasks" });
    firstJournal.append("views-changed", { view: "pins" });
    firstJournal.append("views-changed", { view: "commands" });
    firstSnapshot = snapshot(firstIdentity, firstJournal.latestSeq, "gap-resnapshot");
    const gap = await client.sync();
    expect(gap).toMatchObject({ events: [], resynced: true, engineChanged: false });
    expect(gap.snapshot.projections.marker).toBe("gap-resnapshot");

    // Expiring only the shell lease reattaches to the same engine; no service lifecycle call exists here.
    now += 101;
    const renewed = await client.sync();
    expect(renewed).toMatchObject({ events: [], resynced: true, engineChanged: false });
    expect(ensureCalls).toBe(2);
    expect(currentServer.shellCount()).toBe(1);

    // Expiry is a proven pre-invocation refusal, so reattach then replaying the SAME operation id is safe.
    now += 101;
    const command = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "worker" } };
    const invoked = await client.invoke("operation-client-shell-0001", command);
    expect(invoked).toMatchObject({ status: "ok", method: "agent.start" });
    expect(await client.invoke("operation-client-shell-0001", command)).toEqual(invoked);
    expect(commandExecutions).toBe(1);
    expect(ensureCalls).toBe(3);

    // Replace the server with a genuinely new incarnation on the same endpoint.
    await currentServer.close();
    servers.splice(servers.indexOf(currentServer), 1);
    const secondIdentity = identity(canonicalRoot, "engine-two", "bridge-two");
    const secondJournal = new EngineEventJournal({
      filePath: path.join(root, "events-two.jsonl"),
      engineInstanceId: secondIdentity.instanceId,
    });
    const secondSnapshot = snapshot(secondIdentity, 0, "new-incarnation");
    currentIdentity = secondIdentity;
    currentServer = await startEngineControlServer({
      socketPath,
      identity: secondIdentity,
      getSnapshot: () => secondSnapshot,
      readEvents: (afterSeq, limit) => secondJournal.readAfter(afterSeq, limit),
    });
    servers.push(currentServer);

    const recovered = await client.sync();
    expect(recovered).toMatchObject({ events: [], resynced: true, engineChanged: true });
    expect(recovered.snapshot.projections.marker).toBe("new-incarnation");
    expect(client.identity).toEqual(secondIdentity);
    expect(ensureCalls).toBe(4);

    // Getters and listeners receive clones rather than authority over the client's cached state.
    recovered.snapshot.projections.marker = "caller-mutated";
    expect(client.snapshot.projections.marker).toBe("new-incarnation");
    expect(observed).toEqual([
      { resynced: false, engineChanged: false, marker: "event-one" },
      { resynced: true, engineChanged: false, marker: "gap-resnapshot" },
      { resynced: true, engineChanged: false, marker: "gap-resnapshot" },
      { resynced: true, engineChanged: false, marker: "gap-resnapshot" },
      { resynced: true, engineChanged: true, marker: "new-incarnation" },
    ]);

    const firstClose = client.close();
    expect(client.close()).toBe(firstClose);
    await firstClose;
    expect(currentServer.shellCount()).toBe(0);
    await expect(client.sync()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });

  it("retries when the engine changes between supervisor proof and attach", async () => {
    const root = temp("tachyon-workspace-client-race-");
    const workspaceRoot = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(workspaceRoot, { mode: 0o700 });
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    const socketPath = path.join(runtimeRoot, "control.sock");
    const canonicalRoot = fs.realpathSync(workspaceRoot);
    const staleIdentity = identity(canonicalRoot, "engine-old", "bridge-old");
    const liveIdentity = identity(canonicalRoot, "engine-live", "bridge-live");
    const server = await startEngineControlServer({
      socketPath,
      identity: liveIdentity,
      getSnapshot: () => snapshot(liveIdentity, 0, "live"),
      readEvents: () => ({
        schemaVersion: 1,
        engineInstanceId: liveIdentity.instanceId,
        afterSeq: 0,
        oldestSeq: 1,
        latestSeq: 0,
        resyncRequired: false,
        events: [],
      }),
    });
    servers.push(server);
    let calls = 0;
    const client = await connectRemoteWorkspaceClient({
      workspaceRoot,
      bundle: dummyBundle(root),
      shell: { id: "shell-race-proof", version: "test", locale: "en" },
      ensure: async () => {
        calls += 1;
        return {
          identity: calls === 1 ? staleIdentity : liveIdentity,
          controlSocketPath: socketPath,
          disposition: "reused-exact",
        };
      },
    });
    expect(calls).toBe(2);
    expect(client.identity).toEqual(liveIdentity);
    expect(server.shellCount()).toBe(1);
    await client.close();
  });

  it("refuses an attached engine whose presentation projection is incomplete", async () => {
    const root = temp("tachyon-workspace-client-projection-");
    const workspaceRoot = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(workspaceRoot, { mode: 0o700 });
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    const socketPath = path.join(runtimeRoot, "control.sock");
    const liveIdentity = identity(fs.realpathSync(workspaceRoot), "engine-projection", "bridge-projection");
    const server = await startEngineControlServer({
      socketPath,
      identity: liveIdentity,
      getSnapshot: () => ({
        schemaVersion: 1,
        engineInstanceId: liveIdentity.instanceId,
        seq: 0,
        projections: {},
      }),
    });
    servers.push(server);

    await expect(connectRemoteWorkspaceClient({
      workspaceRoot,
      bundle: dummyBundle(root),
      shell: { id: "shell-invalid-projection", version: "test", locale: "en" },
      ensure: async () => ({
        identity: liveIdentity,
        controlSocketPath: socketPath,
        disposition: "reused-exact",
      }),
    })).rejects.toMatchObject({ code: "INVALID_PROJECTION" });
    expect(server.shellCount()).toBe(0);
  });

  it("never replays a mutation when the transport loses its result", async () => {
    const root = temp("tachyon-workspace-client-unknown-");
    const workspaceRoot = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(workspaceRoot, { mode: 0o700 });
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    const socketPath = path.join(runtimeRoot, "control.sock");
    const liveIdentity = identity(fs.realpathSync(workspaceRoot), "engine-live", "bridge-live");
    let executions = 0;
    let release!: () => void;
    let observedStart!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { observedStart = resolve; });
    const server = await startEngineControlServer({
      socketPath,
      identity: liveIdentity,
      getSnapshot: () => snapshot(liveIdentity, 0, "live"),
      readEvents: () => ({
        schemaVersion: 1,
        engineInstanceId: liveIdentity.instanceId,
        afterSeq: 0,
        oldestSeq: 1,
        latestSeq: 0,
        resyncRequired: false,
        events: [],
      }),
      invoke: async (command) => {
        executions += 1;
        observedStart();
        await gate;
        return workspaceCommandSuccessV1(command);
      },
    });
    servers.push(server);
    const client = await connectRemoteWorkspaceClient({
      workspaceRoot,
      bundle: dummyBundle(root),
      shell: { id: "shell-unknown-outcome", version: "test", locale: "en" },
      ensure: async () => ({
        identity: liveIdentity,
        controlSocketPath: socketPath,
        disposition: "reused-exact",
      }),
    });

    const pending = client.invoke("operation-unknown-0001", {
      schemaVersion: 1,
      method: "agent.start",
      input: { agent: "worker" },
    });
    await started;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    release();
    await expect(pending).rejects.toMatchObject({ code: "OPERATION_OUTCOME_UNKNOWN" });
    expect(executions).toBe(1);
    await client.close();
  });
});

function identity(workspaceRoot: string, instanceId: string, bridgeInstanceId: string): EngineServiceIdentityV1 {
  return {
    schemaVersion: 1,
    workspaceRoot,
    workspaceHash: workspaceHash(workspaceRoot),
    instanceId,
    pid: process.pid,
    processStartIdentity: `linux:test:${instanceId}`,
    startedAt: new Date().toISOString(),
    bundleId: "a".repeat(64),
    engineVersion: "0.57.0-test",
    protocol: { min: 1, max: 1 },
    bridge: { instanceId: bridgeInstanceId, port: instanceId === "engine-two" ? 43_002 : 43_001 },
  };
}

function snapshot(identity: EngineServiceIdentityV1, seq: number, marker: string): WorkspaceSnapshotEnvelopeV1 {
  return {
    schemaVersion: 1,
    engineInstanceId: identity.instanceId,
    seq,
    projections: {
      marker,
      workspace: {
        root: identity.workspaceRoot,
        hash: identity.workspaceHash,
        folderName: path.basename(identity.workspaceRoot),
        configValid: true,
        configFailure: null,
      },
      bridge: {
        instanceId: identity.bridge.instanceId,
        port: identity.bridge.port,
        url: `http://127.0.0.1:${identity.bridge.port}/mcp`,
        direct: true,
      },
      agents: { total: 0, truncated: false, items: [] },
    },
  };
}

function dummyBundle(root: string): StagedEngineBundle {
  return {
    bundleId: "a".repeat(64),
    root,
    entrypoint: path.join(root, "engine.cjs"),
    manifestPath: path.join(root, "engine-manifest.json"),
    reused: true,
  };
}

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
