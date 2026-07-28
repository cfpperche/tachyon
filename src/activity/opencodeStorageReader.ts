import * as fs from "node:fs";
import * as path from "node:path";
import { createOpencodeNormalizer, type OpencodeMessageRecord, type OpencodePartRecord, type OpencodeTurnRecord } from "./opencodeNormalizer.js";
import { ActivityLog } from "./logStore.js";
import type { NormalizedEvent } from "./types.js";

interface OpencodeReaderSessionState {
  seenParts: Record<string, true>;
}

export interface OpencodeReaderState {
  opencode?: {
    sessions: Record<string, OpencodeReaderSessionState>;
  };
}

export class OpencodeStorageReader {
  private readonly normalizer = createOpencodeNormalizer();

  constructor(
    private readonly log: ActivityLog,
    private readonly state: OpencodeReaderState,
    private readonly now: () => string,
  ) {}

  poll(storageRoot: string, sessionId: string): number {
    const store = resolveOpencodeStore(storageRoot);
    if (!store) {
      // t-4a4d30 — the old failure mode was silence: no store, no session, `return 0`, and an agent
      // whose Activity simply stayed empty forever. Say it once per root instead.
      warnOnce(storageRoot);
      return 0;
    }
    const session = store.kind === "sqlite" ? readSqliteSession(store.dbPath, sessionId) : readSession(store.storageRoot, sessionId);
    if (!session) return 0;
    const root = this.state.opencode ??= { sessions: {} };
    const st = root.sessions[sessionId] ??= { seenParts: {} };
    st.seenParts ??= {};
    let appended = 0;
    const turns = store.kind === "sqlite"
      ? readSqliteTurns(store.dbPath, sessionId)
      : readTurns(store.storageRoot, sessionId);
    for (const turn of turns) {
      const unseenParts = turn.parts.filter((part) => part.id && !st.seenParts[part.id]);
      if (unseenParts.length === 0) continue;
      const recordId = `${turn.message.id ?? "message"}:${unseenParts.map((p) => p.id).join(",")}`;
      const events = this.normalizer.push([{ ...turn, parts: unseenParts }]).filter((e) => e.type !== "raw");
      if (events.length > 0) {
        appended += this.log.appendRecord(
          events,
          { runtime: "opencode", sessionId, sourcePath: turn.sourcePath, recordId },
          this.now(),
          collectBlobs(events),
        );
      }
      for (const part of unseenParts) if (part.id) st.seenParts[part.id] = true;
    }
    return appended;
  }
}

/**
 * t-4a4d30 — OpenCode migrated its store from a JSON tree (`storage/session|message|part/**`) to
 * SQLite (`opencode.db`) somewhere before 1.18.5. A home created since then has no `storage/` at
 * all, and a home that predates it keeps one FROZEN beside the live database — measured on the
 * operator's home: newest file under `storage/` 2026-06-10, `opencode.db` written the same day this
 * was found. So the database wins wherever both exist: reading the tree there is reading history.
 */
export type OpencodeStore =
  | { kind: "sqlite"; dbPath: string }
  | { kind: "json"; storageRoot: string };

/**
 * `root` is whatever the session ledger recorded — the opencode data home, or the legacy
 * `<home>/storage` dir. Probe both, prefer the database, and fall back to the tree only when there
 * is no database to read.
 */
export function resolveOpencodeStore(root: string): OpencodeStore | undefined {
  for (const dbPath of [path.join(root, OPENCODE_DB_FILE), path.join(path.dirname(root), OPENCODE_DB_FILE)]) {
    if (isFile(dbPath)) return { kind: "sqlite", dbPath };
  }
  if (isDir(path.join(root, "session"))) return { kind: "json", storageRoot: root };
  return undefined;
}

export const OPENCODE_DB_FILE = "opencode.db";

const warned = new Set<string>();

function warnOnce(root: string): void {
  if (warned.has(root)) return;
  warned.add(root);
  console.warn(
    `[tachyon] OpenCode activity: no readable store under '${root}' — expected '${OPENCODE_DB_FILE}' ` +
    "(opencode ≥ the SQLite migration, measured on 1.18.5) or a legacy 'session/' JSON tree beside it. " +
    "Activity for this agent stays empty until one of them exists.",
  );
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Read-only handle; every failure degrades to "no rows" exactly like the JSON reader's try/catch. */
function withDb<T>(dbPath: string, fn: (db: import("node:sqlite").DatabaseSync) => T, fallback: T): T {
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function readSqliteSession(dbPath: string, sessionId: string): unknown | undefined {
  return withDb(dbPath, (db) => db.prepare("SELECT id FROM session WHERE id = ? LIMIT 1").get(sessionId), undefined);
}

/**
 * The database keeps identity in COLUMNS and the rest of the record in a JSON `data` blob — the same
 * blob the JSON tree used to store as a file, minus the ids. Merging the columns back on top gives
 * the normalizer exactly the record shape it already consumes, so one normalizer serves both stores.
 */
function readSqliteTurns(dbPath: string, sessionId: string): OpencodeTurnRecord[] {
  return withDb(dbPath, (db) => {
    const messages = (db.prepare(
      "SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
    ).all(sessionId) as unknown as SqliteMessageRow[]).flatMap((row) => {
      const rec = parseData<OpencodeMessageRecord>(row.data);
      return rec ? [{ ...rec, id: String(row.id), sessionID: String(row.session_id) }] : [];
    });

    const partsByMessage = new Map<string, OpencodePartRecord[]>();
    for (const row of db.prepare(
      "SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
    ).all(sessionId) as unknown as SqlitePartRow[]) {
      const rec = parseData<OpencodePartRecord>(row.data);
      if (!rec) continue;
      const messageId = String(row.message_id);
      const arr = partsByMessage.get(messageId) ?? [];
      arr.push({ ...rec, id: String(row.id), messageID: messageId, sessionID: String(row.session_id) });
      partsByMessage.set(messageId, arr);
    }

    return messages
      .map((message) => ({ message, parts: partsByMessage.get(message.id ?? "") ?? [], sourcePath: dbPath }))
      .filter((turn) => turn.parts.length > 0);
  }, []);
}

interface SqliteMessageRow { id: unknown; session_id: unknown; time_created: unknown; data: unknown }
interface SqlitePartRow extends SqliteMessageRow { message_id: unknown }

function parseData<T>(data: unknown): T | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function readSession(storageRoot: string, sessionId: string): unknown | undefined {
  try {
    const sessionRoot = path.join(storageRoot, "session");
    for (const project of fs.readdirSync(sessionRoot)) {
      const file = path.join(sessionRoot, project, `${sessionId}.json`);
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readTurns(storageRoot: string, sessionId: string): OpencodeTurnRecord[] {
  const messages = readMessages(storageRoot, sessionId);
  const partsByMessage = readParts(storageRoot, sessionId);
  return messages
    .map((message) => ({ message, parts: partsByMessage.get(message.id ?? "") ?? [], sourcePath: messageSourcePath(storageRoot, sessionId, message.id) }))
    .filter((turn) => turn.parts.length > 0)
    .sort((a, b) => createdMs(a.message) - createdMs(b.message));
}

function readMessages(storageRoot: string, sessionId: string): OpencodeMessageRecord[] {
  const dir = path.join(storageRoot, "message", sessionId);
  const out: OpencodeMessageRecord[] = [];
  for (const file of jsonFiles(dir)) {
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8")) as OpencodeMessageRecord;
      if (rec.sessionID === sessionId && typeof rec.id === "string") out.push(rec);
    } catch {
      /* skip partial/unreadable files */
    }
  }
  return out;
}

function readParts(storageRoot: string, sessionId: string): Map<string, OpencodePartRecord[]> {
  const byMessage = new Map<string, OpencodePartRecord[]>();
  const root = path.join(storageRoot, "part");
  for (const msgDir of dirs(root)) {
    for (const file of jsonFiles(msgDir)) {
      try {
        const rec = JSON.parse(fs.readFileSync(file, "utf8")) as OpencodePartRecord;
        if (rec.sessionID !== sessionId || typeof rec.messageID !== "string") continue;
        const arr = byMessage.get(rec.messageID) ?? [];
        arr.push(rec);
        byMessage.set(rec.messageID, arr);
      } catch {
        /* skip partial/unreadable files */
      }
    }
  }
  for (const arr of byMessage.values()) arr.sort((a, b) => partOrder(a) - partOrder(b));
  return byMessage;
}

function dirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

function jsonFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function createdMs(message: OpencodeMessageRecord): number {
  return typeof message.time?.created === "number" ? message.time.created : 0;
}

function partOrder(part: OpencodePartRecord): number {
  if (typeof part.time?.created === "number") return part.time.created;
  const m = /(\d+)(?=\.json$|$)/.exec(part.id ?? "");
  return m ? Number(m[1]) : 0;
}

function messageSourcePath(storageRoot: string, sessionId: string, messageId: string | undefined): string | undefined {
  return messageId ? path.join(storageRoot, "message", sessionId, `${messageId}.json`) : undefined;
}

function collectBlobs(events: NormalizedEvent[]): Map<string, Buffer> | undefined {
  let m: Map<string, Buffer> | undefined;
  for (const ev of events) {
    if (ev.type !== "image.attached") continue;
    const id = (ev.payload as { id?: string }).id;
    const data = imageDataFromRaw(ev.raw);
    if (id && typeof data === "string") (m ??= new Map()).set(id, Buffer.from(data, "base64"));
  }
  return m;
}

function imageDataFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as { source?: { data?: string }; image_url?: string };
  if (typeof rec.source?.data === "string") return rec.source.data;
  const m = /^data:[^;,]+;base64,(.+)$/s.exec(rec.image_url ?? "");
  return m?.[1];
}
