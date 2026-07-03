import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assigneePatch, canSubmitEdit, cardMenuActions, isStaleError, priorityPatch, resolveDrop, type DragSession } from "../../src/webview/mission-control/interactions.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
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

// dogfood round 3 (#2) — changing priority via the card select errored "update_task requires at least one
// changed field". Reproduced against the REAL TaskStore (not a mock) to settle which of the two suspected
// causes it actually was: (a) the card submits the value the select already had, not the one the user just
// picked (a stale-closure bug in App.tsx's PriorityEditor, fixed by passing the new value straight into
// onSubmit instead of round-tripping through async state), or (b) priorityPatch's `rank:null` (dueto F5)
// normalizes to a no-op patch on a rank-less task. This proves it's (a): rank:null never blocks a genuine
// priority change, and resubmitting the UNCHANGED value is exactly what trips the store's no-op guard.
describe("priorityPatch through TaskStore (dogfood round 3 #2 — no-op no matter the rank)", () => {
  let root: string;
  let store: TaskStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-mc-interactions-"));
    store = new TaskStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("throws 'requires at least one changed field' when the patch resubmits the CURRENT priority (the stale-value bug)", async () => {
    const task = await store.create({ title: "rank-less task", author: "human", priority: 1 });
    expect(task.rank).toBeUndefined();
    const expect_ = { updatedAt: task.updatedAt };
    await expect(store.update(task.id, priorityPatch(1, expect_))).rejects.toThrow(/requires at least one changed field/);
  });

  it("succeeds when the patch actually changes priority, rank:null and all — not a no-op even on a rank-less task", async () => {
    const task = await store.create({ title: "rank-less task", author: "human", priority: 1 });
    expect(task.rank).toBeUndefined();
    const expect_ = { updatedAt: task.updatedAt };
    const next = await store.update(task.id, priorityPatch(2, expect_));
    expect(next.priority).toBe(2);
    expect(next.rank).toBeUndefined();
  });
});

describe("canSubmitEdit", () => {
  it("allows a fresh, non-stale, non-pending session", () => {
    expect(canSubmitEdit({ stale: false, pending: false })).toBe(true);
  });

  it("blocks when there's no session at all", () => {
    expect(canSubmitEdit(undefined)).toBe(false);
  });

  it("blocks a stale session (dueto F7 — needs an explicit refresh, never a silent resubmit)", () => {
    expect(canSubmitEdit({ stale: true, pending: false })).toBe(false);
  });

  it("blocks a submit already in flight (dogfood round 3 #3 — disabling the input mid-submit auto-blurs it, " +
    "which re-invokes the same onBlur-triggered submit with the ORIGINAL now-stale CAS expect)", () => {
    expect(canSubmitEdit({ stale: false, pending: true })).toBe(false);
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

describe("cardMenuActions", () => {
  it("t-c0e711 — offers 'Move to Dropped' only when dropped is a legal transition for this card, " +
    "mirroring drag legality (the SAME allowedDropStatuses affordance data, no separate rule surface)", () => {
    expect(cardMenuActions(["active", "dropped"]).map((a) => a.id)).toEqual(["open-in-studio", "move-to-dropped"]);
  });

  it("omits 'Move to Dropped' when dropped isn't in allowedDropStatuses (e.g. already dropped), but always offers 'Edit in Studio' (spec 339)", () => {
    expect(cardMenuActions(["active", "triaged"]).map((a) => a.id)).toEqual(["open-in-studio"]);
    expect(cardMenuActions([]).map((a) => a.id)).toEqual(["open-in-studio"]);
  });
});
