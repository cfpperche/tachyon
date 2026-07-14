/**
 * Grok Build `chat_history.jsonl` → NormalizedEvent[] (t-9874be).
 *
 * Grounded against live `$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<uuid>/chat_history.jsonl`
 * (2026-07-12, bridge home `.tachyon/bridge-mcp/<agent>.grok`):
 *   - `type: "system"` — system prompt (drop; not a chat turn)
 *   - `type: "user"` + optional `synthetic_reason` — human or injected meta
 *   - `type: "reasoning"` + `summary[]` — model thinking
 *   - `type: "assistant"` + `content` string + optional `tool_calls[]`
 *   - `type: "tool_result"` + `tool_call_id` + `content` string
 *
 * Pure + stateful (pending tool names for result correlation). Host owns session.boundary.
 * Unmapped/unparseable lines degrade silently (no raw bloat in the durable log).
 */

import type { ActivityEventType, ActivityPayloads, NormalizedEvent } from "./types.js";
import type { ActivityNormalizer } from "./codexNormalizer.js";
import { isUserInterrupt } from "./interrupt.js";

interface GrokToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface GrokRecord {
  type?: string;
  id?: string;
  content?: unknown;
  synthetic_reason?: string;
  tool_calls?: GrokToolCall[];
  tool_call_id?: string;
  model_id?: string;
  summary?: Array<{ type?: string; text?: string }>;
  status?: string;
}

/** Tools whose input names a path the agent mutates → file.changed after a successful result. */
const WRITE_TOOLS = new Set(["write", "search_replace", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Tools that merely name a path → file.referenced at call time. */
const READ_TOOLS = new Set(["read_file", "Read", "Glob", "Grep", "grep", "list_dir", "NotebookRead"]);

const INJECTED_TEXT_CAP = 4000;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

interface PendingTool {
  name: string;
  writePath?: string;
}

export function createGrokNormalizer(sourcePath?: string): ActivityNormalizer {
  const pending = new Map<string, PendingTool>();
  let seq = 0;
  /** spec 378 — `assistant.model_id`, latched last-observed-wins. Previously smuggled through
   *  `runtimeVersion` (grok has no separate CLI version source in the transcript). */
  let model: string | undefined;

  const emit = <T extends ActivityEventType>(
    out: NormalizedEvent[],
    type: T,
    _rec: GrokRecord,
    payload: ActivityPayloads[T],
    raw: unknown,
    recordId?: string,
  ): void => {
    out.push({
      type,
      runtime: "grok",
      sequence: seq++,
      ...(model ? { model } : {}),
      recordId,
      sourcePath,
      payload,
      raw,
    });
  };

  return {
    push(lines: string[]): NormalizedEvent[] {
      const out: NormalizedEvent[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: GrokRecord;
        try {
          rec = JSON.parse(trimmed) as GrokRecord;
        } catch {
          continue;
        }
        if (typeof rec.model_id === "string" && rec.model_id) model = rec.model_id;
        // Only stable source ids — synthetic line counters collide across restarts (ActivityLog
        // idempotency key is runtime:session:recordId) and would drop real new tail lines.
        const rid = typeof rec.id === "string" && rec.id
          ? rec.id
          : typeof rec.tool_call_id === "string" && rec.tool_call_id
            ? rec.tool_call_id
            : undefined;

        switch (rec.type) {
          case "system":
            // Full system prompt — not a renderable activity turn.
            break;

          case "user":
            handleUser(out, rec, rid);
            break;

          case "reasoning": {
            const text = (rec.summary ?? [])
              .map((s) => (typeof s?.text === "string" ? s.text : ""))
              .filter((s) => s.trim().length > 0)
              .join("\n")
              .trim();
            if (text) emit(out, "assistant.thinking", rec, { text }, rec, rid);
            break;
          }

          case "assistant":
            handleAssistant(out, rec, rid);
            break;

          case "tool_result":
            handleToolResult(out, rec, rid);
            break;

          default:
            break;
        }
      }
      return out;
    },
  };

  function handleUser(out: NormalizedEvent[], rec: GrokRecord, rid: string | undefined): void {
    const text = textOf(rec.content).trim();
    if (!text) return;

    const reason = rec.synthetic_reason;
    if (reason) {
      // Injected / synthetic user-role rows are never human chat bubbles.
      if (reason === "compaction_meta") {
        emit(out, "compaction.summary", rec, { text: cap(text) }, rec, rid);
        return;
      }
      emit(out, "context.injected", rec, {
        text: cap(text),
        source: reason === "system_reminder" ? "environment" : "hook",
        tagged: text.trimStart().startsWith("<"),
        ...(text.length > INJECTED_TEXT_CAP ? { truncated: true, originalLength: text.length } : {}),
      }, rec, rid);
      return;
    }

    const human = unwrapUserQuery(text);
    if (!human) return;
    if (isUserInterrupt(human)) {
      emit(out, "user.interrupted", rec, { text: human }, rec, rid);
      return;
    }
    if (isTachyonNudge(human)) {
      emit(out, "system.nudge", rec, { text: human }, rec, rid);
      return;
    }
    emit(out, "user.message.completed", rec, { text: human }, rec, rid);
  }

  function handleAssistant(out: NormalizedEvent[], rec: GrokRecord, rid: string | undefined): void {
    const content = typeof rec.content === "string" ? rec.content : textOf(rec.content);
    if (content.trim()) {
      emit(out, "assistant.message.completed", rec, { text: content }, rec, rid);
    }
    const calls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
    for (const call of calls) {
      const name = typeof call.name === "string" && call.name ? call.name : "tool";
      const id = typeof call.id === "string" ? call.id : undefined;
      const input = parseArgs(call.arguments);
      emit(out, "tool.started", rec, { toolUseId: id, name, input }, call, id ?? rid);
      const filePath = pathFromInput(input);
      if (id) pending.set(id, { name, writePath: filePath && WRITE_TOOLS.has(name) ? filePath : undefined });
      if (filePath && READ_TOOLS.has(name)) {
        emit(out, "file.referenced", rec, { path: filePath, tool: name }, call, id ?? rid);
      }
    }
  }

  function handleToolResult(out: NormalizedEvent[], rec: GrokRecord, rid: string | undefined): void {
    const id = typeof rec.tool_call_id === "string" ? rec.tool_call_id : undefined;
    const pendingTool = id ? pending.get(id) : undefined;
    if (id) pending.delete(id);
    const name = pendingTool?.name;
    const full = stringify(rec.content);
    const failed = looksFailed(full);
    emit(
      out,
      failed ? "tool.failed" : "tool.completed",
      rec,
      { toolUseId: id, name, summary: summarize(full), full },
      rec,
      id ?? rid,
    );
    if (!failed && pendingTool?.writePath) {
      emit(out, "file.changed", rec, { path: pendingTool.writePath, tool: name }, rec, id ?? rid);
    }
  }
}

export function normalizeGrok(lines: string[], sourcePath?: string): NormalizedEvent[] {
  return createGrokNormalizer(sourcePath).push(lines);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const o = b as { type?: string; text?: string };
      return typeof o.text === "string" ? o.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Prefer the human-visible body inside `<user_query>`; fall back to full text. */
function unwrapUserQuery(text: string): string {
  const m = USER_QUERY_RE.exec(text);
  if (m) return m[1].trim();
  // Other wrappers (user_info, git_status) without a query body are preamble, not a human turn.
  if (/^\s*<(user_info|git_status)\b/i.test(text) && !USER_QUERY_RE.test(text)) return "";
  return text;
}

function parseArgs(args: unknown): unknown {
  if (args === undefined || args === null) return undefined;
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function pathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "target_file", "path", "notebook_path"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function stringify(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function summarize(full: string | undefined, max = 200): string | undefined {
  if (full === undefined) return undefined;
  const one = full.replace(/\s+/g, " ").trim();
  if (!one) return "";
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function looksFailed(full: string | undefined): boolean {
  if (!full) return false;
  return /^\s*(error|failed|exit:\s*[1-9])/i.test(full);
}

function cap(text: string): string {
  return text.length > INJECTED_TEXT_CAP ? `${text.slice(0, INJECTED_TEXT_CAP)}…` : text;
}

function isTachyonNudge(text: string): boolean {
  return /^\s*\[tachyon\]/i.test(text);
}
