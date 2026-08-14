import { describe, expect, it, vi } from "vitest";
import type { TachyonConfig } from "../../src/config/loadConfig.js";
import type { Task } from "@tachyon/shared/tasks/types.js";
import type { EngineHost } from "../../src/workspace/EngineHost.js";
import { TaskNotificationService } from "../../src/workspace/TaskNotificationService.js";

const task: Task = {
  id: "t-abc123",
  title: "Open me",
  status: "inbox",
  author: "agent",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("TaskNotificationService (t-bae005)", () => {
  function setup(yml?: TachyonConfig["settings"]["taskNotifications"]) {
    const notices: Array<{ message: string; level: string; actions: Array<{ label: string; run: () => void }> }> = [];
    const openTask = vi.fn();
    const host = {
      t: (message: string) => message,
      notify: (message: string, level: string, actions: Array<{ label: string; run: () => void }>) => notices.push({ message, level, actions }),
      openTask,
    } as unknown as EngineHost;
    const config = { settings: { taskNotifications: yml } } as TachyonConfig;
    return { service: new TaskNotificationService("/ws", "wshash01", host, () => config), notices, openTask };
  }

  it("honors a disabled yml value", () => {
    const { service, notices } = setup({ enabled: false });
    service.notify({ type: "created", task, actor: "agent" });
    expect(notices).toEqual([]);
  });

  // t-aaad95 — this used to prove VS Code user scope outranked workspace scope and yml. Those scopes
  // are gone; `tachyon.yml` is the only authority, so the same two behaviors (enabled, and a dedupe
  // window of 0 letting an identical event through twice) are now stated once, from the yml.
  it("emits per yml settings and offers a best-effort Open action", () => {
    const { service, notices, openTask } = setup({ enabled: true, dedupeWindowMs: 0 });
    service.notify({ type: "created", task, actor: "agent" });
    service.notify({ type: "created", task, actor: "agent" });
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ message: "Task created: Open me", level: "info" });
    expect(notices[0].actions[0].label).toBe("Open");
    notices[0].actions[0].run();
    // t-75fd3c — the Open action must deep-link to THIS task, not just focus the sidebar.
    expect(openTask).toHaveBeenCalledOnce();
    expect(openTask).toHaveBeenCalledWith("wshash01", task.id);
  });
});
