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

  it("classifies assignment direction and suppresses a caller's self-assignment", () => {
    const settings: TaskNotificationSettings = { ...DEFAULT_TASK_NOTIFICATION_SETTINGS, events: [...DEFAULT_TASK_NOTIFICATION_SETTINGS.events] };
    expect(taskToastFor({ type: "assigned", task, actor: "a", to: "a" }, settings, "/ws")).toBeUndefined();
    expect(taskToastFor({ type: "assigned", task, actor: "a", to: "b" }, settings, "/ws")?.eventId).toBe("assignedToOther");
    expect(taskToastFor({ type: "assigned", task, actor: "a", to: "a" }, { ...settings, suppressOwnChanges: false }, "/ws")?.eventId).toBe("assignedToMe");
  });

  it("renders the event copy, warning level, and bounded title", () => {
    const longTask = { ...task, title: "x".repeat(140) };
    const toast = taskToastFor({ type: "awaitingHuman", task: longTask, actor: "a", reason: "why", kind: "decision" }, DEFAULT_TASK_NOTIFICATION_SETTINGS, "/ws");
    expect(toast?.message).toMatch(/^Task needs you: x+…$/);
    expect(toast?.message.length).toBeLessThanOrEqual("Task needs you: ".length + 120);
    expect(toast?.level).toBe("warn");
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
