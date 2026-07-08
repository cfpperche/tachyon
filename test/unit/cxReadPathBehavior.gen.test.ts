import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";

class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>>();
  registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

function wireListTasks(store: TaskStore) {
  const mcp = new FakeMcp();
  const deps = {
    workspaceRoot: "/repo",
    tasks: store,
    notify: () => {},
  } satisfies Partial<BridgeDeps> as unknown as BridgeDeps;
  registerTools(mcp as never, deps);
  return async (args: { limit?: number; offset?: number } = {}) => {
    const handler = mcp.handlers.get("list_tasks");
    if (!handler) throw new Error("list_tasks not registered");
    return handler(args);
  };
}

describe("container-generated delegation behavior", () => {
  it("listViews keeps the newest tasks under the read cap and paginates beyond it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cx-read-path-"));
    const store = new TaskStore(root);
    try {
      for (let i = 0; i < 520; i++) {
        await store.create({
          id: `t-${i.toString(16).padStart(6, "0")}`,
          title: `task-${i}`,
          author: "claude",
          now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        });
      }

      const firstPage = store.listViews(500);
      expect(firstPage).toHaveLength(500);
      expect(firstPage.map((v) => v.task.title)).toContain("task-519");
      expect(firstPage.map((v) => v.task.title)).not.toContain("task-0");

      const secondPage = store.listViews(500, { offset: 500 });
      expect(secondPage.map((v) => v.task.title)).toContain("task-19");
      expect(secondPage.map((v) => v.task.title)).toContain("task-0");

      const callListTasks = wireListTasks(store);
      const listed = await callListTasks({ limit: 10, offset: 500 });
      expect(listed.isError).toBeFalsy();
      const summaries = JSON.parse(listed.content[0]!.text) as Array<{ title: string }>;
      expect(summaries.map((s) => s.title)).toEqual([
        "task-19",
        "task-18",
        "task-17",
        "task-16",
        "task-15",
        "task-14",
        "task-13",
        "task-12",
        "task-11",
        "task-10",
      ]);
      expect(listed.content[1]!.text).toContain("offset=510");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
