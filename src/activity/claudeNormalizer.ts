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
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  version?: string;
  subtype?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  toolUseResult?: unknown;
  apiRefusalExplanation?: string;
  apiRefusalCategory?: string;
  message?: { content?: unknown; usage?: Record<string, unknown> };
  /** spec 323 — hook/system attachment records (`type: "attachment"`): only `hook_additional_context`
   *  is promoted to a real event; every other attachment type stays raw (log-filtered) by design. */
  attachment?: { type?: string; hookEvent?: string; hookName?: string; content?: unknown };
}

/** spec 323 — bound what one injected-context event carries into the durable log. */
const INJECTED_TEXT_CAP = 4000;

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
          recordId: rec.uuid, sourcePath, payload, raw,
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
                } else if (block.type === "thinking" && typeof block.thinking === "string") {
                  if (block.thinking.trim()) emit("assistant.thinking", rec, { text: block.thinking }, block);
                } else if (block.type === "image") {
                  const im = imagePayload(block);
                  if (im) emit("image.attached", rec, { ...im, from: "agent" }, block);
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
            // A `user`-role record is one of: a typed HUMAN prompt (string content), a runtime-delivered
            // TOOL RESULT (content has tool_result blocks — NOT a human turn), or injected meta (skip).
            const raw = rec.message?.content;
            if (typeof raw === "string") {
              const text = raw.trim();
              if (rec.isMeta || !text) break;
              // claude injects several `user`-role records that are NOT a human turn — classify them so they
              // never render as a chat bubble (the EDH "appeared as a user message" bug).
              if (rec.isCompactSummary) { emit("compaction.summary", rec, { text: raw }, rec); break; } // post-compaction recap → folds into the boundary
              const cmd = slashCommandOf(text);
              if (cmd) { emit("user.command", rec, { command: cmd }, rec); break; } // `<command-name>/x</command-name>` → a subtle marker
              if (isLocalCommandOutput(text)) break; // `<local-command-stdout>` etc. — local plumbing, drop
              if (isHarnessNotification(text)) break; // `<task-notification>` — background task completion, not a human turn
              if (isTachyonNudge(text)) { emit("system.nudge", rec, { text }, rec); break; } // `[tachyon] …` — host-injected reminder, a system chip not a human bubble
              emit("user.message.completed", rec, { text: raw }, rec);
              break;
            }
            if (!content) break;
            const toolResults = content.filter((b) => (b as Record<string, unknown>).type === "tool_result");
            if (toolResults.length > 0) {
              for (const b of toolResults) {
                const block = b as Record<string, unknown>;
                const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
                const p = id ? pending.get(id) : undefined;
                if (id) pending.delete(id);
                const patch = diffFromPatch(rec.toolUseResult);
                const isRead = p?.name === "Read" || p?.name === "NotebookRead"; // strip its `cat -n` line numbers
                const summary = patch.summary ?? resultSummary(block.content, isRead);
                const full = patch.full ?? fullText(block.content, isRead);
                if (block.is_error) {
                  emit("tool.failed", rec, { toolUseId: id, name: p?.name, summary, full }, block);
                } else {
                  emit("tool.completed", rec, { toolUseId: id, name: p?.name, summary, full }, block);
                  // Success confirms the mutation → NOW the file is `file.changed` (the plan fold).
                  if (p?.writePath) emit("file.changed", rec, { path: p.writePath, tool: p.name }, block);
                }
              }
            } else if (!rec.isMeta) {
              // text blocks with no tool_result → a human turn (e.g. a pasted prompt, "[Request interrupted]").
              const text = content
                .filter((b) => (b as Record<string, unknown>).type === "text")
                .map((b) => (b as Record<string, unknown>).text)
                .filter((t): t is string => typeof t === "string")
                .join("\n").trim();
              if (text) emit("user.message.completed", rec, { text }, rec);
              for (const b of content) {
                if ((b as Record<string, unknown>).type === "image") {
                  const im = imagePayload(b as Record<string, unknown>);
                  if (im) emit("image.attached", rec, { ...im, from: "user" }, b);
                }
              }
            }
            break;
          }
          case "system": {
            if (rec.subtype === "compact_boundary") {
              // Context compaction the runtime wrote IN-FILE — history before it is retained in the same
              // transcript; mark the boundary so the view shows a separator (spec 239 inc 1).
              const m = rec.compactMetadata;
              emit("compaction.boundary", rec, { trigger: m?.trigger, preTokens: numeric(m?.preTokens), postTokens: numeric(m?.postTokens) }, rec);
            } else if (rec.subtype === "model_refusal_fallback" || rec.apiRefusalExplanation) {
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
          case "attachment": {
            // spec 323 — a hook's additionalContext is context silently INJECTED into the session (a user
            // hook or Tachyon's handoff/continuity pointers). Promote it so the feed can answer "why did
            // the agent suddenly do X?". ONE event per attachment (items joined), capped; every other
            // attachment type (hook_success, task_reminder, skill_listing, …) stays raw → log-filtered.
            const att = rec.attachment;
            if (att?.type === "hook_additional_context") {
              const items = Array.isArray(att.content)
                ? att.content.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
                : typeof att.content === "string" && att.content.trim() ? [att.content] : [];
              if (items.length > 0) {
                const joined = items.join("\n");
                const truncated = joined.length > INJECTED_TEXT_CAP;
                emit("context.injected", rec, {
                  text: truncated ? joined.slice(0, INJECTED_TEXT_CAP) : joined,
                  source: "hook",
                  ...(att.hookEvent ? { hookEvent: att.hookEvent } : {}),
                  ...(truncated ? { truncated: true, originalLength: joined.length } : {}),
                }, rec);
                break;
              }
            }
            emit("raw", rec, { note: `attachment:${att?.type ?? ""}` }, rec);
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

/** Extract the slash command from a claude `<command-name>…</command-name>` user record (else undefined). */
function slashCommandOf(text: string): string | undefined {
  const m = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text);
  if (!m) return undefined;
  const name = m[1].trim();
  return name.startsWith("/") ? name : `/${name}`;
}

/** True for a local-command output record (`<local-command-stdout>` / `<local-command-stderr>`) — plumbing. */
function isLocalCommandOutput(text: string): boolean {
  return text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-stderr>");
}

/** True for a harness-injected `user`-role notification that is NOT a human turn — a background Agent/Task
 *  completion delivered as `<task-notification>`. Without this it renders as a human chat bubble (the
 *  "task-notification appeared as a user message" bug). System-reminders are NOT matched here because they
 *  are commonly appended to a genuine human prompt; only a standalone task-notification turn is plumbing. */
function isHarnessNotification(text: string): boolean {
  return text.startsWith("<task-notification>");
}

/** True for a Tachyon-injected nudge — a `[tachyon] …` reminder the host types into the pane (handoff /
 *  continuity prompts). It is delivered as agent input but is NOT a human turn, so it renders as a system
 *  chip rather than a chat bubble. */
function isTachyonNudge(text: string): boolean {
  return text.startsWith("[tachyon]");
}

/** A stable id for an image's base64 payload (content hash + length) — the host keys its one-time send on it. */
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `img_${(h >>> 0).toString(36)}_${s.length}`;
}

/** Lightweight image ref from a base64 image block; the big `data` is left in the raw block for the host. */
function imagePayload(block: Record<string, unknown>): { id: string; mediaType: string } | undefined {
  const src = block.source;
  if (!src || typeof src !== "object") return undefined;
  const s = src as Record<string, unknown>;
  if (s.type !== "base64" || typeof s.data !== "string") return undefined;
  return { id: hashId(s.data), mediaType: typeof s.media_type === "string" ? s.media_type : "image/png" };
}

/** Flatten a tool_result's content (string, or text blocks) to a string. */
function contentText(content: unknown, joiner: string): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as Record<string, unknown>).type === "text" ? (b as Record<string, unknown>).text : undefined))
      .filter((t): t is string => typeof t === "string")
      .join(joiner);
  }
  return undefined;
}

/** Strip the `   123\t` line-number prefix the Read tool prepends (cat -n format) so the chip shows content. */
function stripLineNumbers(text: string): string {
  return text.replace(/^ {0,8}\d+\t/gm, ""); // cat -n: right-padded spaces + number + tab (bounded, spaces only)
}

/** A short one-line summary of a tool_result's content for the activity chip. */
function resultSummary(content: unknown, isRead = false): string | undefined {
  let text = contentText(content, " ");
  if (!text) return undefined;
  if (isRead) text = stripLineNumbers(text);
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return undefined;
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

/** The full tool_result content, capped — the expandable body of a tool chip. */
function fullText(content: unknown, isRead = false): string | undefined {
  let text = contentText(content, "\n");
  if (!text || !text.trim()) return undefined;
  if (isRead) text = stripLineNumbers(text);
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/** A Read/Edit/Write tool_result's `structuredPatch` → a "+N −M" summary + a unified-diff body (capped). */
function diffFromPatch(tur: unknown): { summary?: string; full?: string } {
  if (!tur || typeof tur !== "object") return {};
  const sp = (tur as Record<string, unknown>).structuredPatch;
  if (!Array.isArray(sp)) return {};
  let added = 0, removed = 0;
  const out: string[] = [];
  for (const h of sp) {
    if (!h || typeof h !== "object") continue;
    const hunk = h as Record<string, unknown>;
    const lines = hunk.lines;
    if (!Array.isArray(lines)) continue;
    const n = (k: string): number => (typeof hunk[k] === "number" ? (hunk[k] as number) : 0);
    out.push(`@@ -${n("oldStart")},${n("oldLines")} +${n("newStart")},${n("newLines")} @@`);
    for (const l of lines) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
      out.push(l);
    }
  }
  if (out.length === 0) return {};
  const full = out.join("\n");
  return { summary: `+${added} −${removed}`, full: full.length > 4000 ? `${full.slice(0, 4000)}…` : full };
}
