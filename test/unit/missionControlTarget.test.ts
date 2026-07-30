import { describe, expect, it } from "vitest";
import { workspaceCommandSuccessV1, workspaceMissionControlViewSuccessV1 } from "../../src/engine-service/protocol.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { workspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { projectedAgent, projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

describe("Workspace Mission Control target", () => {
  it("reads one remote board and routes every mutation through a fresh operation identity", async () => {
    const identity = projectionIdentity("/tmp/mission-control-target");
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity, 0, [
        projectedAgent("codex", { running: true, lifetime: "saved" }),
        projectedAgent("reviewer", { running: true, lifetime: "temporary" }),
      ]),
      query: async (query) => {
        expect(query).toEqual({ schemaVersion: 1, method: "task.board", input: { liveTemporaryAgents: ["reviewer"] } });
        return workspaceMissionControlViewSuccessV1({
          schemaVersion: 1,
          board: {
            schemaVersion: 1,
            views: [{
              task: {
                id: "t-abc123",
                title: "remote task",
                body: "search me",
                status: "triaged",
                assignee: "codex",
                author: "human",
                createdAt: "2026-07-14T12:00:00.000Z",
                updatedAt: "2026-07-14T12:00:00.000Z",
              },
            }],
            allowedDropStatuses: { "t-abc123": ["active", "dropped", "inbox"] },
            chips: [{ agent: "codex", source: "declared", next: { taskId: "t-abc123" } }],
          },
        });
      },
      invoke: async (_operationId, command) => workspaceCommandSuccessV1(command),
    });
    const target = workspaceMissionControlTarget(fake);

    expect(target.declaredAgentNames()).toEqual(["codex"]);
    expect(await target.listMissionControlAgents()).toEqual([
      { name: "codex", kind: "agent", running: true, lifetime: "saved" },
      { name: "reviewer", kind: "agent", running: true, lifetime: "temporary" },
    ]);
    expect(await target.boardSnapshot(["reviewer"])).toMatchObject({
      views: [{ task: { id: "t-abc123", body: "search me" } }],
      chips: [{ agent: "codex", next: { task: { id: "t-abc123" } } }],
    });
    await target.updateTask("t-abc123", { status: "active", expect: { status: "triaged" } });
    await target.reorderLane("triaged", 1, {
      orderedIds: ["t-abc123"],
      expect: { "t-abc123": "2026-07-14T12:00:00.000Z" },
    });
    await target.closeValidation("v-abc123", { outcome: "passed", result_note: "dogfood passed" });
    await target.assignValidation("v-abc123", "codex", { assignee: null, updatedAt: "2026-07-14T12:00:00.000Z" });

    expect(fake.invocations.map((entry) => entry.command.method)).toEqual([
      "task.update", "task.reorder-lane", "validation.close", "validation.assign",
    ]);
    expect(fake.invocations.map((entry) => entry.operationId)).toEqual([
      expect.stringMatching(/^mission-control:[0-9a-f-]{36}$/),
      expect.stringMatching(/^mission-control:[0-9a-f-]{36}$/),
      expect.stringMatching(/^mission-control:[0-9a-f-]{36}$/),
      expect.stringMatching(/^mission-control:[0-9a-f-]{36}$/),
    ]);
    expect(new Set(fake.invocations.map((entry) => entry.operationId)).size).toBe(4);
  });

  it("does not turn a typed engine refusal into apparent success", async () => {
    const identity = projectionIdentity("/tmp/mission-control-target-error");
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => ({
        schemaVersion: 1,
        method: command.method,
        status: "error",
        code: "COMMAND_FAILED",
        message: "precondition-failed: stale task",
      }),
    });
    await expect(workspaceMissionControlTarget(fake).updateTask("t-abc123", { status: "triaged" }))
      .rejects.toThrow(/stale task/);
  });

  it("reports a truncated agent projection as unavailable instead of silently omitting live filters", async () => {
    const identity = projectionIdentity("/tmp/mission-control-target-truncated");
    const agents = Array.from({ length: 50 }, (_, index) => projectedAgent(`worker-${index}`));
    const snapshot = projectionSnapshot(identity, 0, agents);
    snapshot.projections.agents = { total: 51, truncated: true, items: agents };
    const fake = new FakeWorkspaceClient({ identity, snapshot });
    await expect(workspaceMissionControlTarget(fake).listMissionControlAgents()).rejects.toThrow(/truncated/);
  });
});
