import { describe, expect, it } from "vitest";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import {
  workspaceGitPresentationTarget,
  workspacePluginPresentationTarget,
  workspacePresentationTarget,
  workspaceProbePresentationTarget,
} from "../../src/shell/WorkspacePresentation.js";
import { workspaceCommandSuccessV1, workspaceProbeViewSuccessV1 } from "../../src/engine-service/protocol.js";
import { projectedAgent, projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

describe("FakeWorkspaceClient", () => {
  it("provides deterministic snapshots, events and exact-operation command results", async () => {
    const identity = projectionIdentity("/tmp/tachyon-fake-workspace");
    let executions = 0;
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity, 0, [projectedAgent("worker")]),
      invoke: async (operationId, command) => {
        executions += 1;
        expect(operationId).toBe("operation-fake-0001");
        return workspaceCommandSuccessV1(command);
      },
      query: async (query) => {
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
    const observed: number[] = [];
    fake.subscribe((result) => {
      observed.push(result.snapshot.seq);
      result.snapshot.projections.agents = "listener mutation";
    });
    fake.enqueueSync({
      snapshot: projectionSnapshot(identity, 1, [projectedAgent("worker", { running: true, attention: "needs-input" })]),
      events: [{
        schemaVersion: 1,
        engineInstanceId: identity.instanceId,
        seq: 1,
        at: new Date(1).toISOString(),
        kind: "views-changed",
        payload: { view: "agents" },
      }],
    });

    expect((await fake.sync()).snapshot.seq).toBe(1);
    expect(observed).toEqual([1]);
    expect(fake.presentation.agents.items[0]?.running).toBe(true);
    expect(workspacePresentationTarget(fake)).toEqual({
      workspaceRoot: identity.workspaceRoot,
      wsHash: identity.workspaceHash,
      folderName: "tachyon-fake-workspace",
    });
    const gitExec = async () => ({ stdout: "", stderr: "", code: 0 });
    expect(workspaceGitPresentationTarget(fake, gitExec).gitExec).toBe(gitExec);
    expect(await workspacePluginPresentationTarget(fake).pluginFleet()).toMatchObject({
      folder: { hash: identity.workspaceHash, name: "tachyon-fake-workspace" },
      bridge: { port: "42897", connected: true },
      agents: [{ name: "worker", status: "needs", attention: "needs-input", adhoc: false }],
    });
    expect(await workspaceProbePresentationTarget(fake).probeView("worker"))
      .toMatchObject({ caller: "worker", empty: true });
    expect(fake.queries).toEqual([{
      schemaVersion: 1,
      method: "probe.view",
      input: { caller: "worker" },
    }]);
    const command = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "worker" } };
    const first = await fake.invoke("operation-fake-0001", command);
    expect(await fake.invoke("operation-fake-0001", command)).toEqual(first);
    expect(executions).toBe(1);
    expect(fake.invocations).toEqual([{ operationId: "operation-fake-0001", command }]);
    expect(await fake.invoke("operation-fake-0001", { ...command, input: { agent: "other" } }))
      .toMatchObject({ status: "error", code: "OPERATION_ID_CONFLICT" });
    expect(executions).toBe(1);
  });

  it("fails closed after detach and on a projection from another engine", async () => {
    const identity = projectionIdentity("/tmp/tachyon-fake-workspace");
    const fake = new FakeWorkspaceClient({ identity, snapshot: projectionSnapshot(identity) });
    const replacement = projectionIdentity(identity.workspaceRoot, {
      workspaceHash: identity.workspaceHash,
      instanceId: "engine-instance-2",
      bridge: { instanceId: "bridge-instance-2", port: 42_898 },
    });
    expect(() => fake.enqueueSync({ snapshot: projectionSnapshot(identity, 1), identity: replacement, engineChanged: true }))
      .toThrow(/attached engine identity/i);

    await fake.close();
    await expect(fake.sync()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(fake.query({ schemaVersion: 1, method: "probe.view", input: {} }))
      .rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(fake.invoke("operation-fake-0002", {
      schemaVersion: 1,
      method: "agent.kill",
      input: { agent: "worker" },
    })).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  });
});
