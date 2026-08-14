/**
 * t-ee0a19 — list_tasks must offer a compact projection an orchestrator can afford
 * when sweeping the board. Full rows carry artifact_refs / timestamps / journalCount
 * freight that triage never reads; without a narrower projection the tool result
 * spills past host caps and the board is read outside the Bridge.
 *
 * Truncation that hides itself is the worse defect: the page note (returned of total)
 * must still fire under compact, and the default shape must stay full so existing
 * callers are not broken.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import { registerTools, type BridgeDeps } from "@tachyon/engine/bridge/tools.js";
import type { TaskStatus } from "@tachyon/shared/tasks/types.js";

class FakeMcp {
  handlers = new Map<
    string,
    (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>
  >();
  registerTool(
    name: string,
    _def: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>,
  ) {
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
  return async (args: { limit?: number; offset?: number; status?: TaskStatus; fields?: "compact" | "full" } = {}) => {
    const handler = mcp.handlers.get("list_tasks");
    if (!handler) throw new Error("list_tasks not registered");
    return handler(args);
  };
}

/** Realistic freight shape measured on the live board: long title + artifact_refs + deps. */
async function seedRealisticBoard(store: TaskStore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const id = `t-${i.toString(16).padStart(6, "0")}`;
    await store.create({
      id,
      title: `Realistic board row ${i}: fix the projection so an orchestrator can sweep without paying artifact_refs and timestamps every time`,
      author: i % 3 === 0 ? "claude" : i % 3 === 1 ? "codex" : "human",
      kind: i % 2 === 0 ? "bug" : "feature",
      body: "Body is never part of list_tasks, but create still accepts it.",
      artifact_refs: [
        { type: "path", ref: `packages/engine/src/bridge/tools/tasks.ts`, role: "deliverable" },
        { type: "path", ref: `src/tasks/boardModel.ts`, role: "relation" },
        { type: "task", ref: "t-ab7708", role: "relation" },
      ],
      deps: i > 0 ? [`t-${(i - 1).toString(16).padStart(6, "0")}`] : undefined,
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
    if (i % 5 === 0) {
      await store.update(id, { status: "triaged", priority: (i % 4) as 0 | 1 | 2 | 3, now: new Date(Date.UTC(2026, 0, 1, 0, 1, i)).toISOString() });
    }
  }
}

const COMPACT_KEYS = new Set(["id", "title", "status", "priority", "kind", "assignee", "deps"]);

describe("t-ee0a19 list_tasks projection", () => {
  it("fields=compact returns only triage/dispatch columns and omits list freight", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "list-tasks-proj-"));
    const store = new TaskStore(root);
    const call = wireListTasks(store);
    try {
      await seedRealisticBoard(store, 3);
      await store.update("t-000000", {
        status: "triaged",
        priority: 1,
        assignee: "boardproj",
        now: "2026-01-02T00:00:00.000Z",
      });

      const compact = await call({ fields: "compact", limit: 10 });
      expect(compact.isError).toBeFalsy();
      const rows = JSON.parse(compact.content[0]!.text) as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          expect(COMPACT_KEYS.has(key)).toBe(true);
        }
        expect(row).not.toHaveProperty("artifact_refs");
        expect(row).not.toHaveProperty("createdAt");
        expect(row).not.toHaveProperty("updatedAt");
        expect(row).not.toHaveProperty("journalCount");
        expect(row).not.toHaveProperty("author");
        expect(row).not.toHaveProperty("body");
        expect(row).toHaveProperty("id");
        expect(row).toHaveProperty("title");
        expect(row).toHaveProperty("status");
      }
      const claimed = rows.find((r) => r.id === "t-000000");
      expect(claimed).toMatchObject({
        id: "t-000000",
        status: "triaged",
        priority: 1,
        assignee: "boardproj",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("default / fields=full keeps the existing full summary shape for callers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "list-tasks-full-"));
    const store = new TaskStore(root);
    const call = wireListTasks(store);
    try {
      await seedRealisticBoard(store, 2);

      const defaulted = await call({ limit: 10 });
      const full = await call({ fields: "full", limit: 10 });
      const defaultRows = JSON.parse(defaulted.content[0]!.text) as Array<Record<string, unknown>>;
      const fullRows = JSON.parse(full.content[0]!.text) as Array<Record<string, unknown>>;
      expect(defaultRows).toEqual(fullRows);
      expect(fullRows[0]).toHaveProperty("artifact_refs");
      expect(fullRows[0]).toHaveProperty("createdAt");
      expect(fullRows[0]).toHaveProperty("updatedAt");
      expect(fullRows[0]).toHaveProperty("author");
      expect(fullRows[0]).not.toHaveProperty("body");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("compact projection of a realistic page stays under the host-affordable ceiling and beats full", async () => {
    // Measured on the live board (2026-08-06): full limit=200 ≈ 116k chars; compact ≈ 45k.
    // Guard: a 200-row realistic page must stay under 80k compact, and compact must be at least
    // 2x cheaper than full on the same set (width problem, not height).
    const N = 200;
    const COMPACT_CEILING_CHARS = 80_000;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "list-tasks-ceiling-"));
    const store = new TaskStore(root);
    const call = wireListTasks(store);
    try {
      await seedRealisticBoard(store, N);

      const fullRes = await call({ fields: "full", limit: N });
      const compactRes = await call({ fields: "compact", limit: N });
      const fullText = fullRes.content[0]!.text;
      const compactText = compactRes.content[0]!.text;
      expect(JSON.parse(compactText)).toHaveLength(N);
      expect(compactText.length).toBeLessThan(COMPACT_CEILING_CHARS);
      expect(fullText.length / compactText.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("compact still announces when the page does not cover the whole matching set", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "list-tasks-trunc-"));
    const store = new TaskStore(root);
    const call = wireListTasks(store);
    try {
      for (let i = 0; i < 5; i++) {
        await store.create({ title: `task-${i}`, author: "claude" });
      }
      const truncated = await call({ fields: "compact", limit: 2 });
      expect(truncated.content).toHaveLength(2);
      expect(JSON.parse(truncated.content[0]!.text)).toHaveLength(2);
      expect(truncated.content[1]!.text).toContain("showing 2 of 5");
      // Freight must not sneak back in under the compact path.
      const row = JSON.parse(truncated.content[0]!.text)[0] as Record<string, unknown>;
      expect(row).not.toHaveProperty("createdAt");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
