import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpencodeStorageReader, resolveOpencodeStore } from "@tachyon/engine/activity/opencodeStorageReader.js";
import { ActivityLog } from "@tachyon/engine/activity/logStore.js";
import { resolveOpencodeId } from "@tachyon/engine/resume/resolvers.js";

/**
 * Bytes captured verbatim from a real `~/.local/share/opencode/opencode.db` (opencode 1.18.5, the
 * `say ok` session t-0338fc measured): the live DDL plus the exact session/project/message/part rows,
 * `data` blobs included. The database under test is materialized from them, so what this pins is the
 * store OpenCode actually writes — not a hand-written idea of it.
 */
const CAPTURED = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "opencode", "session-1.18.5.json"), "utf8"),
) as {
  opencodeVersion: string;
  ddl: Record<string, string>;
  session: Record<string, unknown>;
  project: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  parts: Array<Record<string, unknown>>;
};

const SESSION_ID = CAPTURED.session.id as string;
const CWD = CAPTURED.session.directory as string;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function insert(db: DatabaseSync, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map((c) => (row[c] === null ? null : row[c] as string | number)));
}

/** An opencode data home holding the captured session in the real schema. */
function capturedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-opencode-db-"));
  roots.push(home);
  const dataHome = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(dataHome, { recursive: true });
  const db = new DatabaseSync(path.join(dataHome, "opencode.db"));
  try {
    for (const table of ["project", "session", "message", "part"]) db.exec(CAPTURED.ddl[table]!);
    insert(db, "project", CAPTURED.project);
    insert(db, "session", CAPTURED.session);
    for (const message of CAPTURED.messages) insert(db, "message", message);
    for (const part of CAPTURED.parts) insert(db, "part", part);
  } finally {
    db.close();
  }
  return home;
}

function reader(): { read: OpencodeStorageReader; log: ActivityLog; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-opencode-log-"));
  roots.push(dir);
  const log = new ActivityLog(dir, "oc");
  return { read: new OpencodeStorageReader(log, {}, () => "2026-07-27T00:00:00.000Z"), log, dir };
}

describe("OpenCode activity over the SQLite store (t-4a4d30)", () => {
  it("ingests a real 1.18.5 session the JSON reader could not see", () => {
    expect(CAPTURED.opencodeVersion).toBe("1.18.5");
    const home = capturedHome();
    const dataHome = path.join(home, ".local", "share", "opencode");
    // The layout the old reader required does not exist in this home at all.
    expect(fs.existsSync(path.join(dataHome, "storage"))).toBe(false);
    expect(resolveOpencodeStore(dataHome)).toEqual({ kind: "sqlite", dbPath: path.join(dataHome, "opencode.db") });

    const { read, log } = reader();
    const appended = read.poll(dataHome, SESSION_ID);
    expect(appended).toBeGreaterThan(0);

    const events = log.readTail(100);
    expect(events.map((e) => e.type)).toContain("user.message.completed");
    expect(events.map((e) => e.type)).toContain("assistant.message.completed");
    const user = events.find((e) => e.type === "user.message.completed");
    const assistant = events.find((e) => e.type === "assistant.message.completed");
    expect((user?.payload as { text?: string }).text).toBe("Reply with exactly: ok");
    expect((assistant?.payload as { text?: string }).text).toBe("ok");
    // The provenance t-0338fc needed: the model that actually answered, read back from the store.
    expect(assistant?.model).toBe("opencode-go/glm-5.2");
    expect(assistant?.sessionId).toBe(SESSION_ID);
    // Source path points at the database that was actually read.
    expect(events.every((e) => e.source.runtime === "opencode")).toBe(true);
  });

  it("does not re-append parts it has already seen", () => {
    const dataHome = path.join(capturedHome(), ".local", "share", "opencode");
    const { read } = reader();
    expect(read.poll(dataHome, SESSION_ID)).toBeGreaterThan(0);
    expect(read.poll(dataHome, SESSION_ID)).toBe(0);
  });

  it("still reads a legacy JSON home, and prefers the database when a frozen tree sits beside it", () => {
    const home = capturedHome();
    const dataHome = path.join(home, ".local", "share", "opencode");
    // Pre-migration homes keep `storage/` frozen next to the live database; the database wins.
    const legacySession = path.join(dataHome, "storage", "session", "proj");
    fs.mkdirSync(legacySession, { recursive: true });
    fs.writeFileSync(path.join(legacySession, "ses_frozen.json"), JSON.stringify({ id: "ses_frozen" }), "utf8");
    expect(resolveOpencodeStore(dataHome)).toMatchObject({ kind: "sqlite" });
    // Pointed AT the legacy dir (what the ledger recorded on an old home), the database one level up
    // still wins over the tree it is standing in.
    expect(resolveOpencodeStore(path.join(dataHome, "storage"))).toMatchObject({ kind: "sqlite" });

    // With no database at all, the tree is still readable.
    const jsonOnly = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-opencode-json-"));
    roots.push(jsonOnly);
    fs.mkdirSync(path.join(jsonOnly, "session", "proj"), { recursive: true });
    expect(resolveOpencodeStore(jsonOnly)).toEqual({ kind: "json", storageRoot: jsonOnly });
  });

  it("says so instead of returning a silent zero when neither store exists", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-opencode-empty-"));
    roots.push(empty);
    expect(resolveOpencodeStore(empty)).toBeUndefined();

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const { read } = reader();
      expect(read.poll(empty, SESSION_ID)).toBe(0);
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toMatch(/OpenCode activity: no readable store/);
    expect(warnings.join("\n")).toMatch(/opencode\.db/);
  });

  it("resolves the session id from the database, by cwd and by project worktree", () => {
    const home = capturedHome();
    expect(resolveOpencodeId(CWD, { home })).toBe(SESSION_ID);
    expect(resolveOpencodeId("/not/a/worktree", { home })).toBeNull();
    // A redirected data home (harnessed agent) is honoured over `$HOME/.local/share`.
    expect(resolveOpencodeId(CWD, { home: "/nonexistent", opencodeHome: path.join(home, ".local", "share", "opencode") }))
      .toBe(SESSION_ID);
  });
});
