import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog } from "@tachyon/engine/activity/logStore.js";
import { HermesStorageReader } from "@tachyon/engine/activity/hermesStorageReader.js";
import { ActivityLogWriter } from "@tachyon/engine/activity/logWriter.js";

const roots: string[] = [];
function freshRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-act-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function seedDb(dbPath: string, sessionId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      reasoning TEXT,
      reasoning_content TEXT,
      finish_reason TEXT,
      timestamp TEXT,
      model TEXT,
      active INTEGER DEFAULT 1
    );
  `);
  db.prepare("INSERT INTO messages (session_id, role, content, timestamp, model) VALUES (?, ?, ?, ?, ?)").run(
    sessionId, "user", "hello", "2026-07-12T23:58:00.000Z", "hermes-model-a",
  );
  db.prepare("INSERT INTO messages (session_id, role, content, timestamp, model) VALUES (?, ?, ?, ?, ?)").run(
    sessionId, "assistant", "world", "2026-07-12T23:59:00.000Z", "hermes-model-b",
  );
  db.close();
}

describe("HermesStorageReader", () => {
  it("polls new messages incrementally without duplicates", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const dbPath = path.join(root, "state.db");
    const sid = "20260713_sess1";
    seedDb(dbPath, sid);

    const state: { hermes?: { sessions: Record<string, { lastId: number }> } } = {};
    const log = new ActivityLog(adir, "hermes-agent");
    const reader = new HermesStorageReader(log, state, () => "2026-07-13T00:00:00Z");

    expect(reader.poll(dbPath, sid)).toBe(2);
    expect(reader.poll(dbPath, sid)).toBe(0);
    expect(state.hermes?.sessions[sid]?.lastId).toBe(2);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sid, "user", "again");
    db.close();

    expect(reader.poll(dbPath, sid)).toBe(1);
    const tail = log.readTail(10);
    const texts = tail.map((e) => (e.payload as { text?: string }).text);
    expect(texts).toEqual(["hello", "world", "again"]);
    expect(tail[0]?.timestamp).toBe("2026-07-12T23:58:00.000Z");
    expect(tail[1]?.timestamp).toBe("2026-07-12T23:59:00.000Z");
    expect(tail[0]?.model).toBe("hermes-model-a");
    expect(tail[1]?.model).toBe("hermes-model-b");
  });

  it("cold-start backfill is bounded to the newest 4000 Hermes messages", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const dbPath = path.join(root, "state.db");
    const sid = "large-session";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role TEXT,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        reasoning TEXT,
        reasoning_content TEXT,
        finish_reason TEXT,
        active INTEGER DEFAULT 1
      );
      BEGIN;
    `);
    const add = db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)");
    for (let i = 1; i <= 4501; i++) add.run(sid, `m${i}`);
    db.exec("COMMIT");
    db.close();

    const state: { hermes?: { sessions: Record<string, { lastId: number }> } } = {};
    const log = new ActivityLog(adir, "hermes-agent");
    const reader = new HermesStorageReader(log, state, () => "2026-07-13T00:00:00Z");
    expect(reader.poll(dbPath, sid)).toBe(500);
    expect(state.hermes?.sessions[sid]?.lastId).toBe(1001);
    expect((log.readTail(500)[0]?.payload as { text?: string }).text).toBe("m502");
  });

  it("ActivityLogWriter hermes path stitches via HermesStorageReader", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const dbPath = path.join(root, "state.db");
    const sid = "sessA";
    seedDb(dbPath, sid);

    const w = new ActivityLogWriter(adir, "h1", () => "2026-07-13T00:00:00Z");
    expect(w.poll({ path: dbPath, sessionId: sid, runtime: "hermes" })).toBe(2);
    expect(w.poll({ path: dbPath, sessionId: sid, runtime: "hermes" })).toBe(0);

    // session rotation
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run("sessB", "user", "in B");
    db.close();

    const n = w.poll({ path: dbPath, sessionId: "sessB", runtime: "hermes" });
    expect(n).toBeGreaterThanOrEqual(2); // boundary + message
    const types = new ActivityLog(adir, "h1").readTail(20).map((e) => e.type);
    expect(types).toContain("session.boundary");
    expect(types).toContain("user.message.completed");
  });

  it("does not leak model or pending tool state across Hermes sessions in the same state.db", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const dbPath = path.join(root, "state.db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role TEXT,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        reasoning TEXT,
        reasoning_content TEXT,
        finish_reason TEXT,
        timestamp TEXT,
        model TEXT,
        active INTEGER DEFAULT 1
      );
    `);
    db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_calls, model) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "sessA",
      "assistant",
      "",
      JSON.stringify([{ id: "call_shared", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }]),
      "model-from-session-A",
    );
    db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_call_id, tool_name) VALUES (?, ?, ?, ?, ?)",
    ).run("sessB", "tool", "tool output B", "call_shared", "read_file");
    db.prepare(
      "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
    ).run("sessB", "user", "hello from B without model");
    db.close();

    const state: { hermes?: { sessions: Record<string, { lastId: number }> } } = {};
    const log = new ActivityLog(adir, "hermes-agent");
    const reader = new HermesStorageReader(log, state, () => "2026-07-13T00:00:00Z");

    expect(reader.poll(dbPath, "sessA")).toBeGreaterThan(0);
    expect(reader.poll(dbPath, "sessB")).toBeGreaterThan(0);

    const tail = log.readTail(20);
    const bUser = tail.find((e) => (e.payload as { text?: string }).text === "hello from B without model");
    const bTool = tail.find((e) =>
      (e.payload as { text?: string }).text === "tool output B"
      || (e.payload as { result?: string }).result === "tool output B"
      || (e.type.startsWith("tool.") && JSON.stringify(e.payload).includes("tool output B")),
    );
    expect(bUser).toBeTruthy();
    expect(bUser?.model).toBeUndefined();
    // A tool result for a call id opened only in another session must not complete via leaked pending map.
    // It may emit as a free-standing result, but must not carry session A's model.
    if (bTool) {
      expect(bTool.model).toBeUndefined();
    }
    // No session-B event should inherit session A's latched model.
    for (const e of tail) {
      const text = (e.payload as { text?: string }).text;
      if (text === "hello from B without model" || text === "tool output B") {
        expect(e.model).not.toBe("model-from-session-A");
      }
    }
  });
});
