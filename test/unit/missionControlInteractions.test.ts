import { describe, expect, it } from "vitest";
import { assigneePatch, isStaleError, priorityPatch, resolveDrop, type DragSession } from "../../src/webview/mission-control/interactions.js";
import type { Task } from "../../src/tasks/types.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "t-000001",
    title: "task",
    status: "triaged",
    author: "human",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("priorityPatch / assigneePatch", () => {
  it("priorityPatch always composes rank:null (dueto F5)", () => {
    expect(priorityPatch(0, { updatedAt: "x" })).toEqual({ priority: 0, rank: null, expect: { updatedAt: "x" } });
    expect(priorityPatch(null, { updatedAt: "x" })).toEqual({ priority: null, rank: null, expect: { updatedAt: "x" } });
  });

  it("assigneePatch carries the CAS expect through untouched", () => {
    expect(assigneePatch("codex", { updatedAt: "x" })).toEqual({ assignee: "codex", expect: { updatedAt: "x" } });
    expect(assigneePatch(null, { assignee: null })).toEqual({ assignee: null, expect: { assignee: null } });
  });
});

describe("isStaleError", () => {
  it("recognizes the store's precondition-failed prefix, nothing else", () => {
    expect(isStaleError("precondition-failed: updatedAt did not match")).toBe(true);
    expect(isStaleError("active tasks require assignee")).toBe(false);
  });
});

describe("resolveDrop", () => {
  const session: DragSession = { taskId: "t-000001", fromStatus: "triaged", startUpdatedAt: "2026-07-02T00:00:00.000Z" };

  it("commits when the latest task matches the drag-start snapshot and the target is allowed", () => {
    const latest = task({ status: "triaged", updatedAt: session.startUpdatedAt });
    const decision = resolveDrop(session, latest, "active", ["active", "dropped"]);
    expect(decision).toEqual({
      action: "commit",
      patch: { status: "active", expect: { status: "triaged", updatedAt: session.startUpdatedAt } },
    });
  });

  it("is a no-op when dropped back into the column it started in", () => {
    const latest = task({ status: "triaged", updatedAt: session.startUpdatedAt });
    expect(resolveDrop(session, latest, "triaged", ["active", "dropped"])).toEqual({ action: "noop" });
  });

  it("rejects a target not in the current allowedDropStatuses", () => {
    const latest = task({ status: "triaged", updatedAt: session.startUpdatedAt });
    expect(resolveDrop(session, latest, "done", ["active", "dropped"])).toEqual({ action: "reject", reason: "not-allowed" });
  });

  it("cancels with stale-board when a mid-drag push changed the source task's status underneath", () => {
    const latest = task({ status: "active", updatedAt: session.startUpdatedAt }); // moved elsewhere mid-drag
    expect(resolveDrop(session, latest, "done", ["done", "triaged", "dropped"])).toEqual({ action: "cancel", reason: "stale-board" });
  });

  it("cancels with stale-board when a mid-drag push changed the source task's updatedAt underneath", () => {
    const latest = task({ status: "triaged", updatedAt: "2026-07-02T01:00:00.000Z" }); // same status, edited elsewhere
    expect(resolveDrop(session, latest, "active", ["active", "dropped"])).toEqual({ action: "cancel", reason: "stale-board" });
  });

  it("cancels with stale-board when the source task disappeared mid-drag", () => {
    expect(resolveDrop(session, undefined, "active", ["active", "dropped"])).toEqual({ action: "cancel", reason: "stale-board" });
  });
});
