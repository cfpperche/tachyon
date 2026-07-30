import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_NOTIFICATION_SETTINGS,
  TaskNotificationDeduper,
  resolveTaskNotificationSettings,
  taskAssigneeWakeFor,
  taskToastFor,
  type TaskNotificationSettings,
} from "../../src/tasks/taskNotificationPolicy.js";
import type { Task } from "../../src/tasks/types.js";

const task: Task = {
  id: "t-abc123",
  title: "A task",
  status: "active",
  author: "human",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("task notification policy (t-bae005)", () => {
  // t-aaad95 — this used to pin a three-way precedence (VS Code user > VS Code workspace > yml).
  // The two VS Code scopes were removed with `contributes.configuration`, so what remains to pin is
  // that yml supplies each key independently and the product default fills the rest.
  it("resolves each setting from yml, key by key, over the hardcoded defaults", () => {
    expect(resolveTaskNotificationSettings({
      yml: { enabled: false, dedupeWindowMs: 10, suppressOwnChanges: false },
    })).toEqual({
      enabled: false,
      events: DEFAULT_TASK_NOTIFICATION_SETTINGS.events,
      suppressOwnChanges: false,
      dedupeWindowMs: 10,
    });
  });

  it("lets yml win over the hardcoded defaults", () => {
    expect(resolveTaskNotificationSettings({ yml: { enabled: false, events: ["awaitingHuman"] } })).toMatchObject({
      enabled: false,
      events: ["awaitingHuman"],
    });
  });

  it("classifies non-self assignments as a reachable assignment event and suppresses self-claims by default", () => {
    const settings: TaskNotificationSettings = { ...DEFAULT_TASK_NOTIFICATION_SETTINGS, events: [...DEFAULT_TASK_NOTIFICATION_SETTINGS.events] };
    expect(taskToastFor({ type: "assigned", task, actor: "a", to: "a" }, settings, "/ws")).toBeUndefined();
    expect(taskToastFor({ type: "assigned", task, actor: "a", to: "b" }, settings, "/ws")?.eventId).toBe("assigned");
    expect(taskToastFor({ type: "assigned", task, actor: "a", to: "a" }, { ...settings, suppressOwnChanges: false }, "/ws")?.eventId).toBe("assigned");
  });

  it("keeps another agent's assignment visible when suppressOwnChanges is enabled", () => {
    const settings: TaskNotificationSettings = { ...DEFAULT_TASK_NOTIFICATION_SETTINGS, events: ["assigned"], suppressOwnChanges: true };
    expect(taskToastFor({ type: "assigned", task, actor: "agent-a", to: "agent-b" }, settings, "/ws")).toMatchObject({
      eventId: "assigned",
      message: "Task assigned to agent-b by agent-a: A task",
    });
  });

  it("renders the event copy, warning level, and bounded title", () => {
    const longTask = { ...task, title: "x".repeat(140) };
    const toast = taskToastFor({ type: "awaitingHuman", task: longTask, actor: "a", reason: "why", kind: "decision" }, DEFAULT_TASK_NOTIFICATION_SETTINGS, "/ws");
    expect(toast?.message).toMatch(/^Task needs you — flagged by a: x+…$/);
    expect(toast?.level).toBe("warn");
  });

  // t-18a658 — an agent-caused toast names its agent; non-agent principals stay anonymous.
  it("attributes agent actors in every event copy and keeps non-agent actors anonymous", () => {
    const s = DEFAULT_TASK_NOTIFICATION_SETTINGS;
    expect(taskToastFor({ type: "created", task, actor: "claude" }, s, "/ws")?.message).toBe("Task created by claude: A task");
    expect(taskToastFor({ type: "created", task, actor: "human" }, s, "/ws")?.message).toBe("Task created: A task");
    expect(taskToastFor({ type: "created", task, actor: "master" }, s, "/ws")?.message).toBe("Task created: A task");
    expect(taskToastFor({ type: "statusChanged", task, actor: "claude", from: "active", to: "landed" }, s, "/ws")?.message)
      .toBe("Task t-abc123 moved to landed by claude: A task");
    expect(taskToastFor({ type: "journalAppended", task, actor: "claude" }, s, "/ws")?.message).toBe("Task note added by claude: A task");
    expect(taskToastFor({ type: "journalAppended", task, actor: "external" }, s, "/ws")?.message).toBe("Task note added: A task");
    // self-claim visible only when suppression is off — and then the redundant by-clause is dropped.
    expect(taskToastFor({ type: "assigned", task, actor: "claude", to: "claude" }, { ...s, suppressOwnChanges: false }, "/ws")?.message)
      .toBe("Task assigned to claude: A task");
  });

  it("dedupes within the TTL, expires at the boundary, and allows window zero", () => {
    const deduper = new TaskNotificationDeduper();
    expect(deduper.shouldNotify("key", 100, 1_000)).toBe(true);
    expect(deduper.shouldNotify("key", 100, 1_099)).toBe(false);
    expect(deduper.shouldNotify("key", 100, 1_100)).toBe(true);
    expect(deduper.shouldNotify("key", 0, 1_101)).toBe(true);
    expect(deduper.shouldNotify("key", 0, 1_102)).toBe(true);
  });
});

/**
 * t-57a00a — the human assigned a task in the UI, then moved it to active, and the agent got nothing.
 *
 * The wake-up line existed, but it hung off the Bridge's update_task handler, so agent→agent notified
 * and human→agent (the common case) was silent. The decision now lives here, over before/after alone,
 * so the store's mutation sink — the one point every writer crosses — can run it.
 */
describe("t-57a00a — assignee wake-up", () => {
  const base: Task = { ...task, status: "triaged" };
  const wake = (before: Partial<Task>, after: Partial<Task>, actor?: string) =>
    taskAssigneeWakeFor({ before: { ...base, ...before }, after: { ...base, ...after }, ...(actor ? { actor } : {}) });

  it("wakes the agent a task was just assigned to", () => {
    const result = wake({}, { assignee: "ada" });

    expect(result?.assignee).toBe("ada");
    expect(result?.line).toContain("t-abc123");
    expect(result?.line).toContain("assigned to you");
    expect(result?.line).toContain('get_task("t-abc123")');
  });

  it("wakes the assignee when the task becomes active", () => {
    // The half that was never answered by any path: assignment notified, activation never did — so
    // "I moved it to active and nothing happened" was true even through the Bridge.
    const result = wake({ assignee: "ada" }, { assignee: "ada", status: "active" });

    expect(result?.assignee).toBe("ada");
    expect(result?.line).toContain("now active and assigned to you");
  });

  it("fires once when a patch both assigns and activates", () => {
    const result = wake({}, { assignee: "ada", status: "active" });

    // One event, and it reads as the assignment — that is the news; startable is implied.
    expect(result?.line).toContain("assigned to you");
    expect(result?.line).not.toContain("now active");
  });

  it("does not wake an agent that assigned the task to itself", () => {
    // spec 351 — picking up your own work is not news. This is what the Bridge handler knew and a
    // store-level sink would otherwise lose.
    expect(wake({}, { assignee: "ada" }, "ada")).toBeUndefined();
  });

  it("still wakes when another agent assigns", () => {
    expect(wake({}, { assignee: "ada" }, "grace")?.assignee).toBe("ada");
  });

  it("stays silent on edits that change neither ownership nor executability", () => {
    expect(wake({ assignee: "ada" }, { assignee: "ada", title: "renamed" })).toBeUndefined();
    expect(wake({ assignee: "ada", status: "active" }, { assignee: "ada", status: "active", priority: 0 })).toBeUndefined();
    // Already active, merely re-saved: activation must not re-fire.
    expect(wake({ assignee: "ada", status: "active" }, { assignee: "ada", status: "active" })).toBeUndefined();
  });

  it("stays silent on an unassigned task, however it moves", () => {
    expect(wake({}, { status: "active" })).toBeUndefined();
    expect(wake({ assignee: "ada" }, {})).toBeUndefined();
  });
});
