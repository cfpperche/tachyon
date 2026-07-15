/**
 * Hermes Agent `state.db` messages → NormalizedEvent[] (activity Cap 8).
 *
 * Hermes persists turns in SQLite (`sessions` + `messages`), not per-session JSONL.
 * This normalizer is pure: rows → events. The host (`HermesStorageReader`) owns
 * polling, cursor, and append. Unmapped/unparseable rows degrade silently.
 *
 * Measured schema (Hermes v0.18.x): role user|assistant|tool|system; optional
 * tool_calls (JSON), tool_call_id, tool_name, reasoning / reasoning_content.
 */

import type { ActivityEventType, ActivityPayloads, NormalizedEvent } from "./types.js";
import type { ActivityNormalizer } from "./codexNormalizer.js";
import { isUserInterrupt } from "./interrupt.js";

export interface HermesMessageRow {
  id: number;
  session_id: string;
  role: string;
  content?: string | null;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  tool_name?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  finish_reason?: string | null;
  model?: string | null;
}

const WRITE_TOOLS = new Set(["write", "search_replace", "Write", "Edit", "MultiEdit", "NotebookEdit", "file_write", "edit"]);
const READ_TOOLS = new Set(["read_file", "Read", "Glob", "Grep", "grep", "list_dir", "NotebookRead", "file_read"]);
const INJECTED_TEXT_CAP = 4000;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;
const TACHYON_NUDGE_RE = /^\[tachyon\]/i;

interface PendingTool {
  name: string;
  writePath?: string;
}

/** Stateful normalizer accepting pre-parsed message rows (not transcript lines). */
export function createHermesNormalizer(sourcePath?: string): ActivityNormalizer & { pushRows(rows: HermesMessageRow[]): NormalizedEvent[] } {
  const pending = new Map<string, PendingTool>();
  let seq = 0;
  let runtimeVersion: string | undefined;

  const emit = <T extends ActivityEventType>(
    out: NormalizedEvent[],
    type: T,
    row: HermesMessageRow,
    payload: ActivityPayloads[T],
    raw: unknown,
    recordId?: string,
  ): void => {
    out.push({
      type,
      runtime: "hermes",
      sequence: seq++,
      runtimeVersion: row.model ?? runtimeVersion,
      recordId,
      sourcePath,
      payload,
      raw,
    });
  };

  function pushRows(rows: HermesMessageRow[]): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    for (const row of rows) {
      if (typeof row.model === "string" && row.model) runtimeVersion = row.model;
      const rid = `msg:${row.id}`;
      const role = (row.role || "").toLowerCase();

      switch (role) {
        case "user":
          handleUser(out, row, rid);
          break;
        case "assistant":
          handleAssistant(out, row, rid);
          break;
        case "tool":
        case "function":
          handleToolResult(out, row, rid);
          break;
        case "system":
        case "developer":
          handleInjected(out, row, rid, role === "developer" ? "developer" : "environment");
          break;
        default:
          break;
      }
    }
    return out;
  }

  function handleUser(out: NormalizedEvent[], row: HermesMessageRow, rid: string): void {
    const text = (row.content ?? "").trim();
    if (!text) return;
    if (isUserInterrupt(text)) {
      emit(out, "user.interrupted", row, { text }, row, rid);
      return;
    }
    if (TACHYON_NUDGE_RE.test(text)) {
      emit(out, "system.nudge", row, { text }, row, rid);
      return;
    }
    if (text.startsWith("/") && !text.includes("\n") && text.length < 80) {
      emit(out, "user.command", row, { command: text }, row, rid);
      return;
    }
    const human = unwrapUserQuery(text) || text;
    if (!human.trim()) return;
    emit(out, "user.message.completed", row, { text: human }, row, rid);
  }

  function handleAssistant(out: NormalizedEvent[], row: HermesMessageRow, rid: string): void {
    const thinking = (row.reasoning_content || row.reasoning || "").trim();
    if (thinking) {
      emit(out, "assistant.thinking", row, { text: thinking }, row, `${rid}:think`);
    }
    const content = (row.content ?? "").trim();
    if (content) {
      emit(out, "assistant.message.completed", row, { text: content }, row, rid);
    }
    for (const call of parseToolCalls(row.tool_calls)) {
      const name = call.name || "tool";
      const id = call.id;
      const input = call.arguments;
      emit(out, "tool.started", row, { toolUseId: id, name, input }, call, id ?? `${rid}:tc`);
      const filePath = pathFromInput(input);
      if (id) pending.set(id, { name, writePath: filePath && WRITE_TOOLS.has(name) ? filePath : undefined });
      if (filePath && READ_TOOLS.has(name)) {
        emit(out, "file.referenced", row, { path: filePath, tool: name }, call, id ?? rid);
      }
    }
  }

  function handleToolResult(out: NormalizedEvent[], row: HermesMessageRow, rid: string): void {
    const id = typeof row.tool_call_id === "string" ? row.tool_call_id : undefined;
    const pendingTool = id ? pending.get(id) : undefined;
    if (id) pending.delete(id);
    const name = (typeof row.tool_name === "string" && row.tool_name) || pendingTool?.name;
    const full = row.content ?? "";
    const failed = looksFailed(full);
    emit(
      out,
      failed ? "tool.failed" : "tool.completed",
      row,
      { toolUseId: id, name, summary: summarize(full), full },
      row,
      id ?? rid,
    );
    if (!failed && pendingTool?.writePath) {
      emit(out, "file.changed", row, { path: pendingTool.writePath, tool: name }, row, id ?? rid);
    }
  }

  function handleInjected(
    out: NormalizedEvent[],
    row: HermesMessageRow,
    rid: string,
    source: "hook" | "developer" | "environment",
  ): void {
    const text = (row.content ?? "").trim();
    if (!text) return;
    const capped = text.length > INJECTED_TEXT_CAP;
    emit(
      out,
      "context.injected",
      row,
      {
        text: capped ? text.slice(0, INJECTED_TEXT_CAP) : text,
        source,
        tagged: text.trimStart().startsWith("<"),
        ...(capped ? { truncated: true, originalLength: text.length } : {}),
      },
      row,
      rid,
    );
  }

  // ActivityNormalizer.push(lines) is unused for Hermes (DB path); keep a no-op for interface parity.
  return {
    push: () => [],
    pushRows,
  };
}

/** One-shot helper for tests. */
export function normalizeHermesRows(rows: HermesMessageRow[], sourcePath?: string): NormalizedEvent[] {
  return createHermesNormalizer(sourcePath).pushRows(rows);
}

function parseToolCalls(raw: string | null | undefined): Array<{ id?: string; name?: string; arguments?: unknown }> {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      if (!item || typeof item !== "object") return {};
      const o = item as { id?: string; name?: string; function?: { name?: string; arguments?: unknown }; arguments?: unknown };
      const name = o.name || o.function?.name;
      let args = o.arguments ?? o.function?.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          /* keep string */
        }
      }
      return { id: o.id, name, arguments: args };
    });
  } catch {
    return [];
  }
}

function pathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["path", "file_path", "filePath", "target_file", "filename"]) {
    if (typeof o[k] === "string" && (o[k] as string).trim()) return (o[k] as string).trim();
  }
  return undefined;
}

function unwrapUserQuery(text: string): string {
  const m = USER_QUERY_RE.exec(text);
  return m?.[1]?.trim() || text;
}

function looksFailed(full: string): boolean {
  const t = full.trim();
  if (!t) return false;
  if (/^error\b/i.test(t)) return true;
  if (/"ok"\s*:\s*false/.test(t)) return true;
  if (/"error"\s*:\s*"/i.test(t)) return true;
  return false;
}

function summarize(full: string, max = 200): string {
  const t = full.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}
