/**
 * Poll Hermes `$HERMES_HOME/state.db` for new messages in a session (activity Cap 8).
 *
 * Mirrors `OpencodeStorageReader`: non-JSONL store, cursor per session, append into the
 * shared per-agent ActivityLog. Uses node:sqlite DatabaseSync (same as delivery stores).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ActivityLog } from "./logStore.js";
import { createHermesNormalizer, type HermesMessageRow } from "./hermesNormalizer.js";
import type { NormalizedEvent } from "./types.js";

export interface HermesReaderState {
  hermes?: {
    /** Last ingested messages.id per session (exclusive cursor). */
    sessions: Record<string, { lastId: number }>;
  };
}

/** Match the durable writer's bounded lineage-start policy: keep recent context, never import an
 * arbitrarily large pre-Tachyon Hermes history on first observation. Subsequent polls advance from
 * the persisted cursor and therefore ingest every newly appended message. */
const MAX_HERMES_BACKFILL_MESSAGES = 4000;

export class HermesStorageReader {
  private readonly normalizerBySource = new Map<string, ReturnType<typeof createHermesNormalizer>>();

  constructor(
    private readonly log: ActivityLog,
    private readonly state: HermesReaderState,
    private readonly now: () => string,
  ) {}

  private normalizerFor(sourcePath: string, sessionId: string): ReturnType<typeof createHermesNormalizer> {
    // Key by DB path + session so in-TUI /resume to another row in the same state.db cannot
    // reuse latched model / pending tool-call map / sequence from the prior session.
    const key = `${sourcePath}\0${sessionId}`;
    let n = this.normalizerBySource.get(key);
    if (!n) {
      n = createHermesNormalizer(sourcePath);
      this.normalizerBySource.set(key, n);
    }
    return n;
  }

  /**
   * @param dbPath absolute path to `state.db` (or a dir containing it)
   * @param sessionId Hermes session id (e.g. `20260713_185208_da5df2`)
   */
  poll(dbPath: string, sessionId: string): number {
    const file = resolveDbPath(dbPath);
    if (!file || !fs.existsSync(file)) return 0;
    if (!sessionId) return 0;

    const root = (this.state.hermes ??= { sessions: {} });
    const st = (root.sessions[sessionId] ??= { lastId: 0 });
    if (st.lastId === 0) {
      try {
        st.lastId = initialCursor(file, sessionId);
      } catch {
        return 0;
      }
    }
    const afterId = st.lastId;

    let rows: HermesMessageRow[];
    try {
      rows = readMessagesAfter(file, sessionId, afterId);
    } catch {
      return 0;
    }
    if (rows.length === 0) return 0;

    const normalizer = this.normalizerFor(file, sessionId);
    let appended = 0;
    let maxId = afterId;
    for (const row of rows) {
      maxId = Math.max(maxId, row.id);
      const events = normalizer.pushRows([row]).filter((e) => e.type !== "raw");
      if (events.length === 0) continue;
      const recordId = events[0].recordId ?? `msg:${row.id}`;
      appended += this.log.appendRecord(
        events,
        { runtime: "hermes", sessionId, sourcePath: file, recordId },
        this.now(),
        collectBlobs(events),
      );
    }
    st.lastId = maxId;
    return appended;
  }
}

function resolveDbPath(dbPath: string): string | undefined {
  if (!dbPath) return undefined;
  if (dbPath.endsWith(".db") || dbPath.endsWith(".sqlite") || dbPath.endsWith(".sqlite3")) return dbPath;
  const candidate = path.join(dbPath, "state.db");
  return candidate;
}

function readMessagesAfter(dbPath: string, sessionId: string, afterId: number): HermesMessageRow[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = messageColumns(db);
    const optional = (column: string): string => columns.has(column) ? column : `NULL AS ${column}`;
    const activeFilter = columns.has("active") ? "AND COALESCE(active, 1) = 1" : "";
    const stmt = db.prepare(
      `SELECT id, session_id, role, content,
              ${optional("tool_call_id")}, ${optional("tool_calls")}, ${optional("tool_name")},
              ${optional("reasoning")}, ${optional("reasoning_content")}, ${optional("finish_reason")},
              ${optional("timestamp")}, ${optional("model")}
       FROM messages
       WHERE session_id = ? AND id > ? ${activeFilter}
       ORDER BY id ASC
       LIMIT 500`,
    );
    const raw = stmt.all(sessionId, afterId) as Array<Record<string, unknown>>;
    return raw.map((r) => ({
      id: Number(r.id),
      session_id: String(r.session_id),
      role: String(r.role ?? ""),
      content: r.content == null ? null : String(r.content),
      tool_call_id: r.tool_call_id == null ? null : String(r.tool_call_id),
      tool_calls: r.tool_calls == null ? null : String(r.tool_calls),
      tool_name: r.tool_name == null ? null : String(r.tool_name),
      reasoning: r.reasoning == null ? null : String(r.reasoning),
      reasoning_content: r.reasoning_content == null ? null : String(r.reasoning_content),
      finish_reason: r.finish_reason == null ? null : String(r.finish_reason),
      timestamp: normalizeTimestamp(r.timestamp),
      model: r.model == null ? null : String(r.model),
    }));
  } finally {
    db.close();
  }
}

function initialCursor(dbPath: string, sessionId: string): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = messageColumns(db);
    const activeFilter = columns.has("active") ? "AND COALESCE(active, 1) = 1" : "";
    const row = db.prepare(
      `SELECT id FROM messages
       WHERE session_id = ? ${activeFilter}
       ORDER BY id DESC
       LIMIT 1 OFFSET ${MAX_HERMES_BACKFILL_MESSAGES}`,
    ).get(sessionId) as { id?: unknown } | undefined;
    const id = Number(row?.id ?? 0);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  } finally {
    db.close();
  }
}

function messageColumns(db: import("node:sqlite").DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name?: unknown }>)
      .map((column) => String(column.name ?? "")),
  );
}

function normalizeTimestamp(value: unknown): string | null {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : undefined;
  const date = numeric === undefined
    ? new Date(String(value))
    : new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function collectBlobs(events: NormalizedEvent[]): Map<string, Buffer> | undefined {
  let m: Map<string, Buffer> | undefined;
  for (const ev of events) {
    if (ev.type !== "image.attached") continue;
    const id = (ev.payload as { id?: string }).id;
    if (!id) continue;
    // Hermes activity v1 does not extract image blobs from state.db yet.
  }
  return m;
}
