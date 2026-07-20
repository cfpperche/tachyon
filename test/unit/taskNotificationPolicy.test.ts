import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_NOTIFICATION_SETTINGS,
  TaskNotificationDeduper,
  resolveTaskNotificationSettings,
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
  it("resolves each setting user > workspace > yml > hardcoded", () => {
    expect(resolveTaskNotificationSettings({
      vscodeUser: { enabled: false },
      vscodeWorkspace: { enabled: true, dedupeWindowMs: 10 },
      yml: { enabled: true, dedupeWindowMs: 20, suppressOwnChanges: false },
    })).toEqual({
      enabled: false,
      events: DEFAULT_TASK_NOTIFICATION_SETTINGS.events,
      suppressOwnChanges: false,
      dedupeWindowMs: 10,
    });
  });

  it("lets yml win when VS Code has no explicit value (contributed defaults are not inputs)", () => {
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
