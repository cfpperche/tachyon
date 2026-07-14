import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEngineControlServer, type RunningEngineControlServer } from "../../src/engine-service/controlServer.js";
import { EngineEventJournal } from "../../src/engine-service/eventJournal.js";
import type { StagedEngineBundle } from "../../src/engine-service/engineBundleStore.js";
import type { EngineServiceIdentityV1, WorkspaceSnapshotEnvelopeV1 } from "../../src/engine-service/protocol.js";
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
    expect(client.snapshot.projections).toEqual({ marker: "initial" });
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
    expect(incremental.snapshot.projections).toEqual({ marker: "event-one" });
    expect(ensureCalls).toBe(1);

    // Cursor 1 falls behind a two-record retained tail after seq 4, forcing an honest full resnapshot.
    firstJournal.append("views-changed", { view: "tasks" });
    firstJournal.append("views-changed", { view: "pins" });
    firstJournal.append("views-changed", { view: "commands" });
    firstSnapshot = snapshot(firstIdentity, firstJournal.latestSeq, "gap-resnapshot");
    const gap = await client.sync();
    expect(gap).toMatchObject({ events: [], resynced: true, engineChanged: false });
    expect(gap.snapshot.projections).toEqual({ marker: "gap-resnapshot" });

    // Expiring only the shell lease reattaches to the same engine; no service lifecycle call exists here.
    now += 101;
    const renewed = await client.sync();
    expect(renewed).toMatchObject({ events: [], resynced: true, engineChanged: false });
    expect(ensureCalls).toBe(2);
    expect(currentServer.shellCount()).toBe(1);

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
    expect(recovered.snapshot.projections).toEqual({ marker: "new-incarnation" });
    expect(client.identity).toEqual(secondIdentity);
    expect(ensureCalls).toBe(3);

    // Getters and listeners receive clones rather than authority over the client's cached state.
    recovered.snapshot.projections.marker = "caller-mutated";
    expect(client.snapshot.projections.marker).toBe("new-incarnation");
    expect(observed).toEqual([
      { resynced: false, engineChanged: false, marker: "event-one" },
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
    projections: { marker },
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
