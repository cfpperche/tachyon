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
  it("list_tasks pagination is covered across a page boundary and the listing order has one source of truth", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-read-lows-"));
    const store = new TaskStore(root);
    try {
      // t-5cca25 (1): prior tests only ever sliced offsets exactly at the store's page-size cap
      // (e.g. offset=500). Here the page size (LIMIT) does not divide evenly into a boundary the
      // store computes internally, so a task sitting exactly on the page-1/page-2 seam is the one
      // under test: it must appear on exactly one page, never both (dup) and never neither (skip).
      const TOTAL = 7;
      const LIMIT = 3;
      for (let i = 0; i < TOTAL; i++) {
        await store.create({
          id: `t-${i.toString(16).padStart(6, "0")}`,
          title: `task-${i}`,
          author: "claude",
          now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        });
      }

      const callListTasks = wireListTasks(store);
      const pages: string[][] = [];
      for (let offset = 0; offset < TOTAL; offset += LIMIT) {
        const page = await callListTasks({ limit: LIMIT, offset });
        expect(page.isError).toBeFalsy();
        const summaries = JSON.parse(page.content[0]!.text) as Array<{ title: string }>;
        pages.push(summaries.map((s) => s.title));
      }

      // Newest-first (highest `now` sorts first): page 1 = task-6,5,4; page 2 = task-3,2,1; page 3 = task-0.
      // The boundary tasks (task-4 at the end of page 1, task-3 at the start of page 2) must each
      // land on exactly one page — assert that across every page, no title is duplicated or missing.
      const seen = pages.flat();
      expect(seen).toHaveLength(TOTAL);
      expect(new Set(seen).size).toBe(TOTAL);
      for (let i = 0; i < TOTAL; i++) expect(seen).toContain(`task-${i}`);
      expect(pages[0]).toContain("task-4");
      expect(pages[1]).toContain("task-3");
      expect(pages[0]).not.toContain("task-3");
      expect(pages[1]).not.toContain("task-4");

      // t-5cca25 (2): the actionable/newest-first comparator used to be duplicated between
      // TaskStore's internal read sort and the list_tasks tool's listing sort. Assert both former
      // call sites now import the same exported comparator instead of each keeping their own copy.
      const taskStoreSrc = fs.readFileSync(path.join(__dirname, "../../src/tasks/TaskStore.ts"), "utf8");
      // t-3b47ad — list_tasks lives in the tasks capability module.
      const toolsSrc = fs.readFileSync(path.join(__dirname, "../../src/bridge/tools/tasks.ts"), "utf8");
      expect(taskStoreSrc).toMatch(/import\s*\{[^}]*compareTasksForListing[^}]*\}\s*from\s*["']\.\/listOrder\.js["']/);
      expect(toolsSrc).toMatch(/import\s*\{[^}]*orderTaskViewsForListing[^}]*\}\s*from\s*["']\.\.\/\.\.\/tasks\/listOrder\.js["']/);
      expect(taskStoreSrc).not.toMatch(/TASK_READ_STATUS_ORDER|compareTasksForRead\b/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
