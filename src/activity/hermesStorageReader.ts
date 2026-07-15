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

export class HermesStorageReader {
  private readonly normalizerBySource = new Map<string, ReturnType<typeof createHermesNormalizer>>();

  constructor(
    private readonly log: ActivityLog,
    private readonly state: HermesReaderState,
    private readonly now: () => string,
  ) {}

  private normalizerFor(sourcePath: string): ReturnType<typeof createHermesNormalizer> {
    let n = this.normalizerBySource.get(sourcePath);
    if (!n) {
      n = createHermesNormalizer(sourcePath);
      this.normalizerBySource.set(sourcePath, n);
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
    const afterId = st.lastId;

    let rows: HermesMessageRow[];
    try {
      rows = readMessagesAfter(file, sessionId, afterId);
    } catch {
      return 0;
    }
    if (rows.length === 0) return 0;

    const normalizer = this.normalizerFor(file);
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
    const stmt = db.prepare(
      `SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name,
              reasoning, reasoning_content, finish_reason
       FROM messages
       WHERE session_id = ? AND id > ? AND COALESCE(active, 1) = 1
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
    }));
  } finally {
    db.close();
  }
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
