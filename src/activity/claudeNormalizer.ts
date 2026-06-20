/**
 * Claude transcript → NormalizedEvent[] (spec 238, v1). The normalizer is PURE (no fs/watch) but STATEFUL:
 * the host's tail feeds it COMPLETE transcript lines as they are appended, and it correlates tool calls to
 * their results across chunks. Byte-offset / partial-line buffering lives in the host tail (separate state,
 * per the plan fold); cross-line correlation (a write is only `file.changed` once its `tool_result` proves
 * success; a failed tool's name comes from its earlier `tool_use`) lives here.
 *
 * Grounded against a live ~/.claude/projects/<enc-cwd>/<uuid>.jsonl (2026-06-20): per-line `type`
 * (user|assistant|system|file-history-snapshot|…), `timestamp`, `cwd`, `version`, `sessionId`, and a
 * `message` with content blocks (text | tool_use | tool_result) + `message.usage`.
 *
 * session.* is NOT synthesized here — the host owns spawn/resume/exit lifecycle and emits those. Anything
 * unmapped or unparseable degrades to `raw` (never throws).
 */

import type { ActivityEventType, ActivityPayloads, NormalizedEvent } from "./types.js";

/** Tools whose input names a file the agent MUTATES → file.changed (only once the result succeeds). */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Tools whose input merely NAMES a path → file.referenced (read/scan, emitted at call time). */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);

function pathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "notebook_path", "path"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

interface ClaudeRecord {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  version?: string;
  subtype?: string;
  apiRefusalExplanation?: string;
  apiRefusalCategory?: string;
  message?: { content?: unknown; usage?: Record<string, unknown> };
}

interface PendingTool { name: string; writePath?: string }

export interface ClaudeNormalizer {
  /** Consume newly-appended COMPLETE lines; returns the events they produced (sequence continues). */
  push(lines: string[]): NormalizedEvent[];
}

/** A stateful normalizer the host feeds appended lines. State = pending tool calls + the sequence counter. */
export function createClaudeNormalizer(sourcePath?: string): ClaudeNormalizer {
  const pending = new Map<string, PendingTool>(); // tool_use_id → {name, writePath?}
  let seq = 0;

  return {
    push(lines: string[]): NormalizedEvent[] {
      const out: NormalizedEvent[] = [];
      const emit = <T extends ActivityEventType>(type: T, rec: ClaudeRecord, payload: ActivityPayloads[T], raw: unknown): void => {
        const ev: NormalizedEvent<T> = {
          type, runtime: "claude", sequence: seq++,
          sessionId: rec.sessionId, cwd: rec.cwd, timestamp: rec.timestamp, runtimeVersion: rec.version,
          sourcePath, payload, raw,
        };
        out.push(ev);
      };

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let rec: ClaudeRecord;
        try {
          rec = JSON.parse(trimmed) as ClaudeRecord;
        } catch {
          out.push({ type: "raw", runtime: "claude", sequence: seq++, sourcePath, payload: { note: "unparseable transcript line" }, raw: line });
          continue;
        }

        const content = Array.isArray(rec.message?.content) ? (rec.message!.content as unknown[]) : null;

        switch (rec.type) {
          case "assistant": {
            if (content) {
              for (const b of content) {
                const block = b as Record<string, unknown>;
                if (block.type === "text" && typeof block.text === "string") {
                  emit("assistant.message.completed", rec, { text: block.text }, block);
                } else if (block.type === "tool_use" && typeof block.name === "string") {
                  const name = block.name;
                  const id = typeof block.id === "string" ? block.id : undefined;
                  emit("tool.started", rec, { toolUseId: id, name, input: block.input }, block);
                  const path = pathFromInput(block.input);
                  if (id) pending.set(id, { name, writePath: path && WRITE_TOOLS.has(name) ? path : undefined });
                  // A read names a path at call time → file.referenced now. A WRITE is only `file.changed`
                  // once its tool_result proves success (a failed Edit/Write must not claim a mutation).
                  if (path && READ_TOOLS.has(name)) emit("file.referenced", rec, { path, tool: name }, block);
                }
              }
            }
            const usage = rec.message?.usage;
            if (usage) {
              emit("usage.updated", rec, {
                inputTokens: numeric(usage.input_tokens),
                outputTokens: numeric(usage.output_tokens),
                cacheReadTokens: numeric(usage.cache_read_input_tokens),
                cacheCreationTokens: numeric(usage.cache_creation_input_tokens),
              }, usage);
            }
            break;
          }
          case "user": {
            if (content) {
              for (const b of content) {
                const block = b as Record<string, unknown>;
                if (block.type !== "tool_result") continue;
                const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
                const p = id ? pending.get(id) : undefined;
                if (id) pending.delete(id);
                if (block.is_error) {
                  emit("tool.failed", rec, { toolUseId: id, name: p?.name }, block);
                } else {
                  emit("tool.completed", rec, { toolUseId: id, name: p?.name }, block);
                  // Success confirms the mutation → NOW the file is `file.changed` (the plan fold).
                  if (p?.writePath) emit("file.changed", rec, { path: p.writePath, tool: p.name }, block);
                }
              }
            }
            break;
          }
          case "system": {
            if (rec.subtype === "model_refusal_fallback" || rec.apiRefusalExplanation) {
              emit("error", rec, { message: rec.apiRefusalExplanation ?? "model refusal", category: rec.apiRefusalCategory }, rec);
            } else {
              emit("raw", rec, { note: `system:${rec.subtype ?? ""}` }, rec);
            }
            break;
          }
          case "file-history-snapshot": {
            emit("file.snapshot", rec, {}, rec);
            break;
          }
          default: {
            emit("raw", rec, { note: rec.type }, rec);
          }
        }
      }
      return out;
    },
  };
}

/** Batch convenience (non-streaming callers + tests): normalize an array of lines in one pass. */
export function normalizeClaude(lines: string[], sourcePath?: string): NormalizedEvent[] {
  return createClaudeNormalizer(sourcePath).push(lines);
}

function numeric(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
