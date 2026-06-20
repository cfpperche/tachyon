/**
 * Normalized runtime-activity event model (spec 238). Pure types — no vscode/preact, no fs.
 * The activity view's contract: a per-runtime adapter tails the on-disk transcript and maps it to
 * this runtime-agnostic vocabulary; the webview renders ONLY this. Model *activity*, not each
 * runtime's full ontology — keep `raw` + `runtimeSpecific` so an adapter never flattens badly.
 *
 * v1 commits to the transcript-tail-friendly subset below (flushed lines, no fake streaming).
 * Streaming-delta + permission/diff events are deferred (additive) until a real stream/SSE adapter
 * or fixtures prove a runtime surfaces them — see plan § codex plan-review folds.
 */

export type RuntimeId = "claude" | "codex" | "opencode" | "gemini" | "qwen" | "generic";

/** How much structured activity a runtime can actually yield — drives the view's honest promises. */
export type CapabilityTier = "structured" | "heuristic" | "raw-only";

/** v1 committed event vocabulary. Deferred (future): assistant.message.delta, tool.output.delta,
 *  diff.proposed, permission.requested. */
export type ActivityEventType =
  | "session.started"
  | "session.resumed"
  | "session.ended"
  | "user.message.completed"
  | "user.command"
  | "assistant.message.completed"
  | "assistant.thinking"
  | "image.attached"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "file.referenced"
  | "file.changed"
  | "file.snapshot"
  | "usage.updated"
  | "compaction.boundary"
  | "compaction.summary"
  | "error"
  | "raw";

/** Typed payloads, keyed by event type. Every shape is additive-only. */
export interface ActivityPayloads {
  "session.started": { title?: string };
  "session.resumed": { title?: string };
  "session.ended": { reason?: string };
  "user.message.completed": { text: string };
  /** A slash command the human invoked (claude records it as a `<command-name>…` user record) — rendered as
   *  a subtle marker, NOT a chat bubble (the raw XML wrapper is not a human message). */
  "user.command": { command: string };
  "assistant.message.completed": { text: string };
  "assistant.thinking": { text: string };
  /** A base64 image block. The big `data` stays in `raw` (the host posts it ONCE on a side channel keyed
   *  by `id`, not in the per-render view-model) — the payload is just the lightweight reference. */
  "image.attached": { id: string; mediaType: string; from: "user" | "agent" };
  "tool.started": { toolUseId?: string; name: string; input?: unknown };
  "tool.completed": { toolUseId?: string; name?: string; summary?: string; full?: string };
  "tool.failed": { toolUseId?: string; name?: string; summary?: string; full?: string };
  "file.referenced": { path: string; tool?: string };
  "file.changed": { path: string; tool?: string };
  "file.snapshot": { paths?: string[] };
  "usage.updated": {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  /** A context-compaction event the runtime wrote IN-FILE (claude `system.subtype:"compact_boundary"`).
   *  History is NOT lost — the pre-compaction records remain in the same transcript; this just marks where
   *  the runtime summarized so the view can render a separator (spec 239 inc 1). */
  "compaction.boundary": { trigger?: string; preTokens?: number; postTokens?: number };
  /** The post-compaction recap claude injects as an `isCompactSummary` user record — folded into the
   *  boundary marker as an expandable summary, never a human bubble. */
  "compaction.summary": { text: string };
  error: { message: string; category?: string };
  raw: { note?: string };
}

export interface NormalizedEvent<T extends ActivityEventType = ActivityEventType> {
  type: T;
  runtime: RuntimeId;
  /** Monotonic within a single normalize pass; the host re-stamps across appends as it tails. */
  sequence: number;
  sessionId?: string;
  cwd?: string;
  /** ISO timestamp from the transcript line when present. */
  timestamp?: string;
  /** Runtime version stamped per source line (drift forensics) — claude exposes `version`. */
  runtimeVersion?: string;
  /** Stable per-record id from the source transcript (claude `uuid`) — provenance for the durable log
   *  (spec 239); preferred over a byte offset because it survives prune/rotate/rewrite. */
  recordId?: string;
  /** The transcript file this event came from. */
  sourcePath?: string;
  payload: ActivityPayloads[T];
  /** The original source record, untouched — the escape hatch for everything normalization drops. */
  raw: unknown;
}
