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
  | "assistant.message.completed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "file.referenced"
  | "file.changed"
  | "file.snapshot"
  | "usage.updated"
  | "error"
  | "raw";

/** Typed payloads, keyed by event type. Every shape is additive-only. */
export interface ActivityPayloads {
  "session.started": { title?: string };
  "session.resumed": { title?: string };
  "session.ended": { reason?: string };
  "user.message.completed": { text: string };
  "assistant.message.completed": { text: string };
  "tool.started": { toolUseId?: string; name: string; input?: unknown };
  "tool.completed": { toolUseId?: string; name?: string; summary?: string };
  "tool.failed": { toolUseId?: string; name?: string; summary?: string };
  "file.referenced": { path: string; tool?: string };
  "file.changed": { path: string; tool?: string };
  "file.snapshot": { paths?: string[] };
  "usage.updated": {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
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
  /** The transcript file this event came from. */
  sourcePath?: string;
  payload: ActivityPayloads[T];
  /** The original source record, untouched — the escape hatch for everything normalization drops. */
  raw: unknown;
}
