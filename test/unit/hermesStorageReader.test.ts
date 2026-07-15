import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog } from "../../src/activity/logStore.js";
import { HermesStorageReader } from "../../src/activity/hermesStorageReader.js";
import { ActivityLogWriter } from "../../src/activity/logWriter.js";

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
      active INTEGER DEFAULT 1
    );
  `);
  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, "user", "hello");
  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, "assistant", "world");
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
    const texts = log.readTail(10).map((e) => (e.payload as { text?: string }).text);
    expect(texts).toEqual(["hello", "world", "again"]);
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
});
