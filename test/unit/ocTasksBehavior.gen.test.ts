import { describe, expect, it, afterAll, beforeAll, expectTypeOf } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { TaskStore, taskSummary } from "@tachyon/engine/tasks/TaskStore.js";
import { orderTaskViewsForListing, LISTING_STATUS_ORDER } from "@tachyon/engine/tasks/listOrder.js";
import { TASK_STATUSES, type TaskStatus, type TaskView } from "@tachyon/shared/tasks/types.js";
import { registerTools, type BridgeDeps } from "@tachyon/engine/bridge/tools.js";

/** A fake MCP server that just captures tool handlers (mirrors test/unit/probeBridge.test.ts). */
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
  return async (args: { limit?: number; offset?: number; status?: TaskStatus } = {}) => {
    const handler = mcp.handlers.get("list_tasks");
    if (!handler) throw new Error("list_tasks not registered");
    return handler(args);
  };
}

/**
 * t-f64a90 — the list_tasks Bridge tool buried actionable work under the default limit=100 + an
 * ascending-createdAt read order. This behavior test exercises the same read→order→cap→summarize
 * pipeline the tool uses (without spinning the full HTTP Bridge): the actionable-first sort + the
 * status filter must keep triaged/active surfaced, never silently truncated by the cap.
 */

function callToolListingLayer(store: TaskStore, { limit = 100, status }: { limit?: number; status?: TaskStatus } = {}) {
  // Mirrors packages/engine/src/bridge/tools.ts list_tasks handler (t-f64a90): full bounded read, then sort/filter, then cap.
  const all = store.listViews(500);
  const ordered = orderTaskViewsForListing(all, status);
  return ordered.slice(0, limit).map(taskSummary);
}

let root: string;
let store: TaskStore;

beforeAll(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "octasks-behavior-"));
  store = new TaskStore(root);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("container-generated delegation behavior", () => {
  it("list_tasks surfaces actionable tasks first and honors a status filter", async () => {
    // Seed a board that reproduces the bug's shape: a wall of terminal tasks (done/landed/dropped)
    // emitted BEFORE the actionable ones — exactly what buried triaged/active beyond limit=100.
    // createdAt ordering below puts NEW actionable tasks AFTER old terminals (the bug scenario).
    const seed: Array<{ title: string; status: TaskStatus; updatedAt: string }> = [
      { title: "old-done-1", status: "done", updatedAt: "2026-01-01T00:00:00.000Z" },
      { title: "old-done-2", status: "done", updatedAt: "2026-02-01T00:00:00.000Z" },
      { title: "old-landed", status: "landed", updatedAt: "2026-03-01T00:00:00.000Z" },
      { title: "old-dropped", status: "dropped", updatedAt: "2026-04-01T00:00:00.000Z" },
      { title: "triaged-stale", status: "triaged", updatedAt: "2026-06-09T00:00:00.000Z" },
      { title: "triaged-mid", status: "triaged", updatedAt: "2026-06-10T00:00:00.000Z" },
      { title: "triaged-fresh", status: "triaged", updatedAt: "2026-06-12T00:00:00.000Z" },
      { title: "active-now", status: "active", updatedAt: "2026-06-05T00:00:00.000Z" },
      { title: "inbox-new", status: "inbox", updatedAt: "2026-06-08T00:00:00.000Z" },
    ];
    // createdAt asc — the old read order — so terminal tasks are written first (bug repro shape).
    const created: { id: string }[] = [];
    for (const s of seed) {
      const t = await store.create({ title: s.title, author: "claude", now: s.updatedAt });
      created.push({ id: t.id });
    }
    // Walk each task along allowed transitions (see allowedTransitions) to its target status, carrying
    // the same updatedAt through every step so the final updatedAt is deterministic per the seed matrix.
    async function setFinal(idx: number, status: TaskStatus, updatedAt: string) {
      const id = created[idx]!.id;
      await store.update(id, { status: "triaged", now: updatedAt });
      if (status === "triaged") return;
      // active requires an assignee (assertTransition); assign a placeholder before transiting.
      await store.update(id, { assignee: "claude", now: updatedAt });
      await store.update(id, { status: "active", now: updatedAt });
      if (status === "active") return;
      // assignee becomes immutable once we leave active; just transition the status.
      await store.update(id, { status, now: updatedAt }); // active -> landed | done | dropped
    }
    await setFinal(0, "done", "2026-01-01T00:00:00.000Z");
    await setFinal(1, "done", "2026-02-01T00:00:00.000Z");
    await setFinal(2, "landed", "2026-03-01T00:00:00.000Z");
    await setFinal(3, "dropped", "2026-04-01T00:00:00.000Z");
    await setFinal(4, "triaged", "2026-06-09T00:00:00.000Z");
    await setFinal(5, "triaged", "2026-06-10T00:00:00.000Z");
    await setFinal(6, "triaged", "2026-06-12T00:00:00.000Z");
    await setFinal(7, "triaged", "2026-06-05T00:00:00.000Z");
    await store.update(created[7]!.id, { assignee: "claude", now: "2026-06-05T00:00:00.000Z" });
    await store.update(created[7]!.id, { status: "active", now: "2026-06-05T00:00:00.000Z" });
    // inbox-new: create left it inbox; bump its updatedAt so it sorts deterministically within the inbox group.
    await store.update(created[8]!.id, { status: "triaged", now: "2026-06-08T00:00:00.000Z" });
    await store.update(created[8]!.id, { status: "inbox", now: "2026-06-08T00:05:00.000Z" });

    // 1. Default (no status filter) ordering: actionable FIRST. Even with a tight cap, terminals must not
    //    crowd out active/triaged/inbox — the regression that buried the 8 actionable tasks at limit=100.
    const defaultCapped = callToolListingLayer(store, { limit: 4 });
    let lastRank = -1;
    for (const s of defaultCapped) {
      const rank = LISTING_STATUS_ORDER[s.status as TaskStatus];
      expect(rank).toBeGreaterThanOrEqual(lastRank);
      lastRank = rank;
    }
    // active is the top of the order, so slot 0 must be the active task.
    expect(defaultCapped[0]!.status).toBe("active");
    // Terminal states (done/landed/dropped) must NOT appear in the capped default surface.
    for (const s of defaultCapped) {
      expect(["done", "dropped", "landed"]).not.toContain(s.status);
    }

    // 2. Full default list, asserted in full ordering shape — actionable first, terminal last, stable
    //    newest-updated tiebreak within a group.
    const full = callToolListingLayer(store, { limit: 500 });
    const statuses = full.map((s) => s.status);
    const firstActive = statuses.indexOf("active");
    const firstTriaged = statuses.indexOf("triaged");
    const firstInbox = statuses.indexOf("inbox");
    const firstLanded = statuses.indexOf("landed");
    const firstDone = statuses.indexOf("done");
    const firstDropped = statuses.indexOf("dropped");
    expect(firstActive).toBeLessThan(firstTriaged);
    expect(firstTriaged).toBeLessThan(firstInbox);
    expect(firstInbox).toBeLessThan(firstLanded);
    expect(firstLanded).toBeLessThan(firstDone);
    expect(firstDone).toBeLessThan(firstDropped);
    // within triaged, newest updated first
    const triaged = full.filter((s) => s.status === "triaged").map((s) => s.title);
    expect(triaged[0]).toBe("triaged-fresh");
    expect(triaged[1]).toBe("triaged-mid");
    expect(triaged[2]).toBe("triaged-stale");

    // 3. Status filter: list_tasks(status: "triaged") returns ONLY triaged, in newest-first order, and
    //    is never truncated regardless of how many terminals were seeded before it.
    const triagedOnly = callToolListingLayer(store, { status: "triaged", limit: 100 });
    expect(triagedOnly).toHaveLength(3);
    expect(triagedOnly.every((s) => s.status === "triaged")).toBe(true);
    expect(triagedOnly.map((s) => s.title)).toEqual(["triaged-fresh", "triaged-mid", "triaged-stale"]);
    // A cap smaller than the triaged lane width still returns the most recently touched triaged tasks,
    // never a terminal — the silent-truncation bug is fixed.
    const triagedCappedToTwo = callToolListingLayer(store, { status: "triaged", limit: 2 });
    expect(triagedCappedToTwo.map((s) => s.title)).toEqual(["triaged-fresh", "triaged-mid"]);

    // 4. orderTaskViewsForListing is pure (no in-place mutation of its input) + deterministic for ties.
    const views: TaskView[] = [
      { task: { id: "t-aaaaaa", title: "x", status: "triaged", author: "h", createdAt: "1", updatedAt: "u" } },
      { task: { id: "t-bbbbbb", title: "y", status: "triaged", author: "h", createdAt: "1", updatedAt: "u" } },
    ];
    const inputSameUpdate = views.slice();
    orderTaskViewsForListing(inputSameUpdate);
    expect(inputSameUpdate.map((v) => v.task.id)).toEqual(["t-aaaaaa", "t-bbbbbb"]); // unchanged ordering check
    const sorted = orderTaskViewsForListing(views);
    expect(views.map((v) => v.task.id)).toEqual(["t-aaaaaa", "t-bbbbbb"]); // input not mutated
    expect(sorted.map((v) => v.task.id)).toEqual(["t-aaaaaa", "t-bbbbbb"]); // stable id tiebreak, asc

    // 5. status filter rejects an unknown lane name without throwing — it simply returns nothing (zod rejects earlier at the tool boundary).
    const unknown = orderTaskViewsForListing(views, "active" as TaskStatus).filter((v) => v.task.status === "active");
    expect(unknown).toHaveLength(0);

    // 6. LISTING_STATUS_ORDER is a total order over every TASK_STATUSES value (no status left ambiguous).
    for (const s of TASK_STATUSES) {
      expect(LISTING_STATUS_ORDER[s]).toBeTypeOf("number");
    }
    expectTypeOf(LISTING_STATUS_ORDER).toMatchObjectType<Record<TaskStatus, number>>();
  });

  it("list_tasks tells the caller when the cap actually truncated the result, and stays silent when it didn't", async () => {
    const truncRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "octasks-behavior-trunc-"));
    const truncStore = new TaskStore(truncRoot);
    const call = wireListTasks(truncStore);
    try {
      for (let i = 0; i < 5; i++) {
        await truncStore.create({ title: `task-${i}`, author: "claude" });
      }

      // Cap smaller than the matching set: the real Bridge tool must say so, not just silently hand back
      // a partial page (the bug shape this task fixes) — as a second, non-JSON text block so the first
      // block stays a plain parseable array for existing callers.
      const truncated = await call({ limit: 2 });
      expect(truncated.content).toHaveLength(2);
      expect(() => JSON.parse(truncated.content[0]!.text)).not.toThrow();
      expect(JSON.parse(truncated.content[0]!.text)).toHaveLength(2);
      expect(truncated.content[1]!.text).toContain("showing 2 of 5");
      expect(truncated.content[1]!.text.toLowerCase()).toContain("limit");

      // Cap not reached: no truncation note, single content block, shape unchanged from before this fix.
      const untruncated = await call({ limit: 5 });
      expect(untruncated.content).toHaveLength(1);
      expect(JSON.parse(untruncated.content[0]!.text)).toHaveLength(5);

      // Cap exactly equal to the matching set is also NOT truncation — boundary case.
      const exact = await call({ limit: 100, status: undefined });
      expect(exact.content).toHaveLength(1);
    } finally {
      fs.rmSync(truncRoot, { recursive: true, force: true });
    }
  });

  it("list_tasks points callers to the next page when matching tasks exceed the current page, and stays silent when the store fits", async () => {
    // t-3fb7d1: `listViews` now orders before slicing and accepts an offset, so a store with >500 tasks is
    // reachable through pagination. Fake a `TaskStore` whose `count()` reports a true total larger than what
    // the current page hands back, to exercise the Bridge note without writing 500+ real task files.
    function fakeStore(total: number, returned: number): TaskStore {
      const views: TaskView[] = Array.from({ length: returned }, (_, i) => ({
        task: {
          id: `t-${i.toString(16).padStart(6, "0")}`,
          title: `task-${i}`,
          status: "triaged" as TaskStatus,
          author: "claude",
          createdAt: `2026-01-01T00:00:00.${i.toString().padStart(3, "0")}Z`,
          updatedAt: `2026-01-01T00:00:00.${i.toString().padStart(3, "0")}Z`,
        },
      }));
      return { listViews: () => views, count: () => total } as unknown as TaskStore;
    }

    // Store holds 800 tasks; the current 500-task page has another page after it. The tool must say so explicitly.
    const overCap = wireListTasks(fakeStore(800, 500));
    const overCapResult = await overCap({ limit: 500 });
    expect(overCapResult.content).toHaveLength(2);
    expect(JSON.parse(overCapResult.content[0]!.text)).toHaveLength(500);
    const note = overCapResult.content[1]!.text;
    expect(note.toLowerCase()).toContain("note");
    expect(note).toContain("800");
    expect(note).toContain("offset=500");

    // Store total matches what listViews returned: no store-truncation warning, single content block.
    const underCap = wireListTasks(fakeStore(500, 500));
    const underCapResult = await underCap({ limit: 500 });
    expect(underCapResult.content).toHaveLength(1);
  });
});
