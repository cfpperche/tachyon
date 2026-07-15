import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBoardSnapshot } from "../../src/tasks/boardSnapshot.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import {
  isMissionControlViewV1,
  missionControlBoardSnapshot,
  parseMissionControlBoardProjectionV1,
  projectMissionControlBoard,
  type MissionControlBoardProjectionV1,
} from "../../src/runtime-api/missionControlProjection.js";
import {
  MISSION_CONTROL_RESPONSE_MAX_BYTES,
  workspaceMissionControlViewSuccessV1,
} from "../../src/engine-service/protocol.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Mission Control wire projection", () => {
  it("round-trips the board fields the UI consumes without duplicating task bodies in chips or validation history", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-control-projection-"));
    roots.push(root);
    const taskStore = new TaskStore(root);
    const validationStore = new ValidationStore(root);
    const task = await taskStore.create({
      id: "t-abc123",
      title: "Persistent board",
      author: "human",
      body: "searchable body",
      artifact_refs: [{ type: "sdd", ref: "382-persistent-engine-shell-boundary" }],
      deps: ["t-def456"],
      now: "2026-07-14T12:00:00.000Z",
    });
    await taskStore.update(task.id, {
      status: "triaged",
      assignee: "codex",
      now: "2026-07-14T12:01:00.000Z",
    });
    await taskStore.update(task.id, {
      awaitingHuman: { reason: "Need installed dogfood", since: "2026-07-14T12:01:30.000Z", kind: "dogfood" },
      now: "2026-07-14T12:01:30.000Z",
    });
    const open = await validationStore.create({ title: "Human check", author: "human", executor: "human", now: "2026-07-14T12:02:00.000Z" });
    const closed = await validationStore.create({ title: "Old check", author: "human", now: "2026-07-14T12:03:00.000Z" });
    await validationStore.closeRound(closed.id, { outcome: "passed", result_note: "done", now: "2026-07-14T12:04:00.000Z" });
    const source = buildBoardSnapshot({
      store: taskStore,
      declaredAgents: ["codex"],
      liveAdhocAgents: ["reviewer"],
      validationStore,
      workspaceRoot: root,
    });
    source.attachmentCounts = { [task.id]: 2 };

    const projected = projectMissionControlBoard(source);
    const restored = missionControlBoardSnapshot(projected);

    expect(projected.views[0]?.task).toMatchObject({ id: task.id, body: "searchable body", assignee: "codex", awaitingHuman: { kind: "dogfood" } });
    expect(projected.views[0]?.task).not.toHaveProperty("artifact_refs");
    expect(projected.views[0]?.task).not.toHaveProperty("deps");
    expect(projected.chips.find((chip) => chip.agent === "codex")?.next).toEqual({ taskId: task.id });
    expect(JSON.stringify(projected.chips)).not.toContain("searchable body");
    expect(projected.validations?.items.map((item) => item.id)).toEqual([open.id]);
    expect(JSON.stringify(projected.validations)).not.toContain("rounds");
    expect(restored.chips.find((chip) => chip.agent === "codex")?.next).toMatchObject({ task: { id: task.id, body: "searchable body" } });
    expect(restored).toMatchObject({ attachmentCounts: { [task.id]: 2 }, validations: { pendingCount: 1, humanPendingCount: 1 } });
  });

  it("fails closed on unknown fields, contradictory counts and chip references outside the task set", () => {
    const projection = minimalProjection();
    expect(() => parseMissionControlBoardProjectionV1({ ...projection, extra: true })).toThrow(/unknown or missing fields/);
    expect(() => parseMissionControlBoardProjectionV1({
      ...projection,
      chips: [{ agent: "codex", source: "declared", next: { taskId: "t-ffffff" } }],
    })).toThrow(/task is missing/);
    expect(() => parseMissionControlBoardProjectionV1({
      ...projection,
      validations: {
        items: [], pendingCount: 1, humanPendingCount: 0, agentPendingCount: 0, candidateCount: 0, candidates: [],
      },
    })).toThrow(/counts contradict/);
    expect(isMissionControlViewV1({ schemaVersion: 1, board: projection })).toBe(true);
    expect(isMissionControlViewV1({ schemaVersion: 1, board: projection, agentLiveness: { status: "available" } })).toBe(false);
  });

  it("keeps a maximal ordinary 500-card board below its dedicated cap and rejects an adversarial oversized view", () => {
    const ordinary = largeProjection({ attentionRows: 0 });
    const ordinaryResult = workspaceMissionControlViewSuccessV1({ schemaVersion: 1, board: ordinary });
    const ordinaryEnvelope = `${JSON.stringify({ ok: true, op: "query", result: ordinaryResult })}\n`;
    expect(Buffer.byteLength(ordinaryEnvelope, "utf8")).toBeLessThan(MISSION_CONTROL_RESPONSE_MAX_BYTES);

    const oversized = largeProjection({ attentionRows: 8 });
    expect(() => workspaceMissionControlViewSuccessV1({ schemaVersion: 1, board: oversized }))
      .toThrow(/dedicated response size limit/);
  }, 20_000);
});

function minimalProjection(): MissionControlBoardProjectionV1 {
  return {
    schemaVersion: 1,
    views: [{
      task: {
        id: "t-000001",
        title: "one",
        status: "inbox",
        author: "human",
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:00:00.000Z",
      },
      derived: {},
    }],
    allowedDropStatuses: { "t-000001": ["triaged", "dropped"] },
    chips: [{ agent: "human", source: "human", next: { empty: true, reason: "all-blocked" } }],
  };
}

function largeProjection(options: { attentionRows: number }): MissionControlBoardProjectionV1 {
  const body = "😀".repeat(4_000);
  const message = "😀".repeat(2_000);
  const ref = "😀".repeat(500);
  const views = Array.from({ length: 500 }, (_, index) => {
    const id = `t-${index.toString(16).padStart(6, "0")}`;
    return {
      task: {
        id,
        title: `task ${index}`,
        body,
        status: "inbox" as const,
        author: "human",
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:00:00.000Z",
      },
      ...(options.attentionRows > 0 ? {
        attention: Array.from({ length: options.attentionRows }, () => ({ code: "dangling_dep" as const, message, ref })),
      } : {}),
    };
  });
  return parseMissionControlBoardProjectionV1({
    schemaVersion: 1,
    views,
    allowedDropStatuses: Object.fromEntries(views.map((view) => [view.task.id, ["triaged", "dropped"]])),
    chips: [],
  });
}
