import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import type { TaskNotificationEvent } from "../../src/tasks/taskNotificationPolicy.js";

class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
  registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

describe("Bridge task notification events (t-bae005)", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

  function setup(caller: BridgeDeps["caller"] = { kind: "agent", name: "worker" }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-task-notify-"));
    roots.push(root);
    const tasks = new TaskStore(root);
    const events: TaskNotificationEvent[] = [];
    const mcp = new FakeMcp();
    registerTools(mcp as never, { workspaceRoot: root, tasks, caller, onTaskNotificationEvent: (event: TaskNotificationEvent) => events.push(event) } as unknown as BridgeDeps);
    const call = (name: string, args: Record<string, unknown>) => mcp.handlers.get(name)!(args);
    return { tasks, events, call };
  }

  it("emits created only after create succeeds", async () => {
    const { events, call } = setup();
    await call("create_task", { title: "created" });
    expect(events).toMatchObject([{ type: "created", actor: "worker", task: { title: "created" } }]);
  });

  it("emits changed assignment and status, but not a reasserted assignment", async () => {
    const { tasks, events, call } = setup();
    const task = await tasks.create({ title: "edit", author: "human" });
    await call("update_task", { id: task.id, assignee: "other", status: "triaged", expect: {} });
    expect(events.map((event) => event.type)).toEqual(["assigned", "statusChanged"]);
    events.length = 0;
    await call("update_task", { id: task.id, assignee: "other", expect: {} });
    expect(events).toEqual([]);
  });

  it("emits nothing for a rejected update", async () => {
    const { tasks, events, call } = setup();
    const task = await tasks.create({ title: "edit", author: "human" });
    const result = await call("update_task", { id: task.id, status: "active", expect: { status: "done" } });
    expect(result.isError).toBe(true);
    expect(events).toEqual([]);
  });

  it("emits awaiting-human and active-task journal events after success", async () => {
    const { tasks, events, call } = setup();
    const task = await tasks.create({ title: "active", author: "human" });
    await tasks.update(task.id, { status: "triaged" });
    await tasks.update(task.id, { status: "active", assignee: "worker" });
    await call("flag_for_human", { id: task.id, reason: "choose", kind: "decision" });
    await call("append_task_note", { id: task.id, text: "context" });
    expect(events.map((event) => event.type)).toEqual(["awaitingHuman", "journalAppended"]);
  });
});
