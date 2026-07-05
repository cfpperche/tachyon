/**
 * Activity view-model (spec 238, increment 2). PURE — turns a normalized event stream into a render-ready
 * model the webview draws directly (no parsing, no fs in the view). Built to answer the five scan questions
 * the cockpit promises: what is the agent doing now / which files did it touch / what failed / what did it
 * cost / open the referenced file. Everything else stays in the raw escape hatch.
 */

import type { CapabilityTier, NormalizedEvent, RuntimeId } from "./types.js";

/** One render-ready feed entry. `kind` drives the icon/treatment; `path` (when set) is clickable. */
export interface ActivityItem {
  sequence: number;
  kind: "message" | "command" | "nudge" | "injected" | "thinking" | "image" | "tool" | "file" | "usage" | "error" | "raw" | "session" | "boundary";
  /** For chat bubbles: who spoke. "user" → right, "agent" → left; absent for non-message activity. */
  role?: "user" | "agent";
  title: string;
  /** Secondary line — tool args (the command/file/pattern) for a tool chip. */
  detail?: string;
  /** Outcome summary attached once the tool's result arrives (a tool chip; ↳ in the view). */
  result?: string;
  /** The expandable body of a tool result — a diff (Edit/Write) or full output (Bash/Read), capped. */
  resultFull?: string;
  /** For an image item: the content-hashed id the host's one-time image-data send is keyed on. */
  imageId?: string;
  /** Host-issued deterministic token for shareable items; webview echoes it so stale clicks fail closed. */
  shareKey?: string;
  path?: string;
  failed?: boolean;
  timestamp?: string;
}

/** Assistant turn markers that carry no real content (tachyon/claude artifacts) — kept out of the chat. */
const MESSAGE_NOISE = new Set(["No response requested."]);

/** Event types that end a compaction boundary's "pending" window (a real conversational turn) — sidecar/raw
 *  events between the boundary and its summary do NOT reset it. */
const RESETS_BOUNDARY = new Set<string>([
  "user.message.completed", "user.interrupted", "user.command", "assistant.message.completed", "assistant.thinking",
  "image.attached", "tool.started", "tool.completed", "tool.failed", "error",
]);

/** A short, human label for a tool's input (the command / file / pattern) + the clickable path if a file. */
function toolDisplay(name: string, input: unknown): { detail?: string; path?: string } {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const filePath = str("file_path") ?? str("notebook_path");
  let detail: string | undefined;
  let path: string | undefined = filePath;
  switch (name) {
    case "Bash": detail = str("command"); break;
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": case "NotebookRead":
      detail = filePath ? tailPath(filePath) : undefined; break;
    case "Grep": detail = str("pattern"); path = str("path") && !filePath ? undefined : filePath; break;
    case "Glob": detail = str("pattern") ?? str("path"); break;
    case "Task": detail = str("description") ?? str("subagent_type"); break;
    case "WebFetch": detail = str("url"); break;
    case "WebSearch": detail = str("query"); break;
    default: detail = str("file_path") ?? str("query") ?? str("command") ?? str("pattern") ?? str("path");
  }
  if (detail && detail.length > 90) detail = `${detail.slice(0, 90)}…`;
  return { detail, path };
}

function tailPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 1 ? p : `…/${parts[parts.length - 1]}`;
}

/** Human label for a session boundary. Tachyon-initiated actions (restarted/resumed/forked/started) carry an
 *  exact reason; in-TUI switches are inferred (resume = a known session, new = /clear or fresh). */
function sessionBoundaryLabel(reason?: string): string {
  switch (reason) {
    case "restarted": return "restarted session";
    case "resumed": case "resume": return "resumed session";
    case "forked": return "forked session";
    case "started": case "new": case "fresh": return "new session";
    default: return "session changed";
  }
}

/** Compact token count for the compaction-boundary label: 1002519 → "1.0M", 17671 → "18k". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

export interface ActivitySummary {
  messages: number;
  /** tool.started without a matching tool.completed/failed (by toolUseId). */
  toolsRunning: number;
  toolsFailed: number;
  filesChanged: string[];
  filesReferenced: string[];
  tokens: { input: number; output: number };
  lastActivity?: string;
}

/** The agent's live work state — host-injected from Tachyon's AttentionMonitor (the same signal that drives
 *  the sidebar "working" pill; parsed from the runtime's own pane spinner), NOT derived from the transcript. */
export type AgentActivityState = "working" | "idle" | "needs-input";

export interface ActivityViewModel {
  runtime?: RuntimeId;
  runtimeVersion?: string;
  sourcePath?: string;
  tier: CapabilityTier;
  /** True when the host's freshness gate failed → the view says "recent activity", not "live". */
  degradedFreshness?: boolean;
  /** Live work state (host-injected). "working" → the typing indicator; "needs-input" → a waiting hint. */
  agentState?: AgentActivityState;
  summary: ActivitySummary;
  items: ActivityItem[];
  /** Total item count BEFORE the host trims `items` to the render cap — lets the webview surface a visible
   *  "showing recent N of M" notice instead of silently dropping the oldest activity. */
  totalItems?: number;
  /** True when ≥2 resumable agents share this agent's cwd — session stitching is suppressed there
   *  (prefer-gap-over-misattribution, spec 239); the view shows an honest notice. */
  sharedCwd?: boolean;
  /** True when older activity exists before the rendered window (in the loaded window or on disk) — drives the
   *  "load earlier activity" control (spec 239 inc 6 backward paging). */
  hasOlder?: boolean;
}

export function buildActivityView(
  events: NormalizedEvent[],
  opts: { tier?: CapabilityTier; degradedFreshness?: boolean } = {},
): ActivityViewModel {
  const b = createActivityBuilder();
  b.push(events);
  return b.view(opts);
}

export interface ActivityBuilder {
  /** Fold only the NEWLY-appended events into the running model (O(new), not O(all)) — the host calls this
   *  with each tail chunk so a long session never re-walks the whole event log per render. */
  push(events: NormalizedEvent[]): void;
  /** Snapshot the current view-model. `items` is the live array (the host slices it; it never mutates it). */
  view(opts?: { tier?: CapabilityTier; degradedFreshness?: boolean }): ActivityViewModel;
}

/** Stateful, incremental builder backing buildActivityView — the perf path for the live tail (spec 238 #4). */
export function createActivityBuilder(): ActivityBuilder {
  const items: ActivityItem[] = [];
  const changed = new Set<string>();
  const referenced = new Set<string>();
  const startedTools = new Set<string>();
  const chipByToolUseId = new Map<string, ActivityItem>(); // started chip, to attach the result later
  let messages = 0;
  let toolsFailed = 0;
  let inTok = 0;
  let outTok = 0;
  let lastActivity: string | undefined;
  let runtime: RuntimeId | undefined;
  let runtimeVersion: string | undefined;
  let sourcePath: string | undefined;
  const seenMessageItems = new Map<string, number>();
  // A compaction summary folds into its boundary ONLY while the boundary is still "pending" — set on the
  // boundary, cleared as soon as a real conversational turn intervenes (sidecar/raw events don't clear it,
  // so the runtime's between-records noise is tolerated). Prevents an orphan summary attaching to a stale
  // boundary (codex review).
  let pendingBoundary: ActivityItem | undefined;

  const push = (events: NormalizedEvent[]): void => {
  for (const e of events) {
    if (e.timestamp) lastActivity = e.timestamp;
    runtime = e.runtime; // the latest event's runtime (consistent across a session)
    if (!runtimeVersion && e.runtimeVersion) runtimeVersion = e.runtimeVersion;
    if (!sourcePath && e.sourcePath) sourcePath = e.sourcePath;
    switch (e.type) {
      case "session.started":
      case "session.resumed":
      case "session.ended":
        items.push({ sequence: e.sequence, kind: "session", title: e.type.replace("session.", ""), timestamp: e.timestamp });
        break;
      case "user.message.completed": {
        const text = displayMessageText((e.payload as { text: string }).text);
        if (!text) break;
        if (!markMessageItem("user", e.timestamp, text)) break;
        items.push({ sequence: e.sequence, kind: "message", role: "user", title: text, timestamp: e.timestamp });
        break;
      }
      case "user.interrupted": {
        items.push({ sequence: e.sequence, kind: "boundary", title: "interrupted by user", timestamp: e.timestamp });
        pendingBoundary = undefined;
        break;
      }
      case "system.nudge": {
        const text = (e.payload as { text: string }).text.replace(/^\[tachyon\]\s*/, ""); // drop the marker for display
        items.push({ sequence: e.sequence, kind: "nudge", title: text, timestamp: e.timestamp });
        break;
      }
      case "context.injected": {
        // spec 323 + t-09cde6 — silently-injected context is system/context, never a human chat bubble.
        // Tagged non-environment runtime preambles stay in the durable log for audit, while Codex's
        // `<environment_context>` is rendered as a dim collapsible row for traceability.
        const p = e.payload as { text: string; source?: string; tagged?: boolean; truncated?: boolean; originalLength?: number };
        if (p.tagged && p.source !== "environment") break;
        const detail = p.source === "environment" ? "environment" : p.source === "hook" ? "hook" : "runtime";
        const trunc = p.truncated && typeof p.originalLength === "number" ? ` · truncated from ${p.originalLength} chars` : "";
        items.push({ sequence: e.sequence, kind: "injected", title: "context", detail: `${detail}${trunc}`, resultFull: p.text, timestamp: e.timestamp });
        break;
      }
      case "assistant.message.completed": {
        const text = displayMessageText((e.payload as { text: string }).text);
        if (!text) break;
        if (MESSAGE_NOISE.has(text.trim())) break; // a turn marker, not real content
        if (!markMessageItem("agent", e.timestamp, text)) break;
        messages++;
        items.push({ sequence: e.sequence, kind: "message", role: "agent", title: text, timestamp: e.timestamp });
        break;
      }
      case "assistant.thinking": {
        items.push({ sequence: e.sequence, kind: "thinking", role: "agent", title: (e.payload as { text: string }).text, timestamp: e.timestamp });
        break;
      }
      case "image.attached": {
        const p = e.payload as { id: string; mediaType: string; from: "user" | "agent" };
        items.push({ sequence: e.sequence, kind: "image", role: p.from, imageId: p.id, detail: p.mediaType, title: "image", timestamp: e.timestamp });
        break;
      }
      case "tool.started": {
        const p = e.payload as { toolUseId?: string; name: string; input?: unknown };
        if (p.toolUseId) startedTools.add(p.toolUseId);
        const { detail, path } = toolDisplay(p.name, p.input);
        const item: ActivityItem = { sequence: e.sequence, kind: "tool", title: p.name, detail, path, timestamp: e.timestamp };
        items.push(item);
        if (p.toolUseId) chipByToolUseId.set(p.toolUseId, item);
        break;
      }
      case "tool.completed": {
        const p = e.payload as { toolUseId?: string; summary?: string; full?: string };
        if (p.toolUseId) startedTools.delete(p.toolUseId);
        const chip = p.toolUseId ? chipByToolUseId.get(p.toolUseId) : undefined;
        if (chip) { if (p.summary) chip.result = p.summary; if (p.full) chip.resultFull = p.full; }
        break;
      }
      case "tool.failed": {
        const p = e.payload as { toolUseId?: string; name?: string; summary?: string; full?: string };
        if (p.toolUseId) startedTools.delete(p.toolUseId);
        toolsFailed++;
        const chip = p.toolUseId ? chipByToolUseId.get(p.toolUseId) : undefined;
        if (chip) { chip.failed = true; chip.result = p.summary ?? "failed"; chip.resultFull = p.full; }
        else items.push({ sequence: e.sequence, kind: "tool", title: p.name ?? "tool", result: p.summary ?? "failed", resultFull: p.full, failed: true, timestamp: e.timestamp });
        break;
      }
      // file.* feed the SUMMARY only — the tool chip already shows (and links) the file, so no separate item.
      case "file.changed": changed.add((e.payload as { path: string }).path); break;
      case "file.referenced": referenced.add((e.payload as { path: string }).path); break;
      case "file.snapshot": break; // summary-only signal (not proof THIS agent changed a file)
      case "usage.updated": {
        const p = e.payload as { inputTokens?: number; outputTokens?: number };
        if (typeof p.inputTokens === "number") inTok += p.inputTokens;
        if (typeof p.outputTokens === "number") outTok += p.outputTokens;
        break;
      }
      case "compaction.boundary": {
        // History is NOT lost (the pre-compaction records stay in-file) — render a separator marking where
        // the runtime summarized the context (spec 239 inc 1).
        const p = e.payload as { trigger?: string; preTokens?: number; postTokens?: number };
        const label = p.trigger === "manual" ? "context compacted · manual" : "context compacted";
        const detail = typeof p.preTokens === "number" && typeof p.postTokens === "number"
          ? `${fmtTokens(p.preTokens)} → ${fmtTokens(p.postTokens)} tokens`
          : undefined;
        const item: ActivityItem = { sequence: e.sequence, kind: "boundary", title: label, detail, timestamp: e.timestamp };
        items.push(item);
        pendingBoundary = item;
        break;
      }
      case "compaction.summary": {
        // The post-compaction recap claude injects as a user record — fold it into the PENDING boundary
        // (the one just emitted) as an expandable body (NOT a human bubble). Standalone fallback otherwise.
        const text = (e.payload as { text: string }).text.trim();
        if (pendingBoundary) pendingBoundary.resultFull = text;
        else items.push({ sequence: e.sequence, kind: "boundary", title: "context compacted", resultFull: text, timestamp: e.timestamp });
        break;
      }
      case "user.command": {
        // A slash command the human invoked — a subtle marker, never a chat bubble.
        items.push({ sequence: e.sequence, kind: "command", title: (e.payload as { command: string }).command, timestamp: e.timestamp });
        break;
      }
      case "session.boundary": {
        // The runtime rotated to a different session file (a /clear, /resume, or fresh start) — a separator
        // between stitched sessions in the durable per-agent log (spec 239 inc 3b).
        const p = e.payload as { reason?: string };
        items.push({ sequence: e.sequence, kind: "boundary", title: sessionBoundaryLabel(p.reason), timestamp: e.timestamp });
        pendingBoundary = undefined; // a session boundary is not a compaction; don't fold a later summary into it
        break;
      }
      case "error": {
        const p = e.payload as { message: string };
        items.push({ sequence: e.sequence, kind: "error", title: p.message, failed: true, timestamp: e.timestamp });
        break;
      }
      case "raw":
        // Kept out of the primary feed by default (it's the escape-hatch); the view can reveal it on demand.
        break;
    }
    // A real conversational turn closes the boundary's pending window so a later orphan summary can't attach
    // to a stale boundary (sidecar/raw events between a boundary and its summary are tolerated).
    if (RESETS_BOUNDARY.has(e.type)) pendingBoundary = undefined;
  }
  };

  const view = (opts: { tier?: CapabilityTier; degradedFreshness?: boolean } = {}): ActivityViewModel => ({
    runtime,
    runtimeVersion,
    sourcePath,
    tier: opts.tier ?? "structured",
    degradedFreshness: opts.degradedFreshness,
    summary: {
      messages,
      toolsRunning: startedTools.size,
      toolsFailed,
      filesChanged: [...changed],
      filesReferenced: [...referenced],
      tokens: { input: inTok, output: outTok },
      lastActivity,
    },
    items,
    totalItems: items.length, // host trims `items` to the cap but keeps this, so the view can say "N of M"
  });

  return { push, view };

  function markMessageItem(role: "user" | "agent", timestamp: string | undefined, text: string): boolean {
    const t = Date.parse(timestamp ?? "");
    if (!Number.isFinite(t)) return true;
    const key = `${role}\0${canonicalMessageItemText(text)}`;
    const prior = seenMessageItems.get(key);
    if (prior !== undefined && Math.abs(t - prior) <= 2000) return false;
    seenMessageItems.set(key, t);
    return true;
  }
}

function canonicalMessageItemText(text: string): string {
  return displayMessageText(text);
}

function displayMessageText(text: string): string {
  return text
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/g, "")
    .replace(/<image\b[^>]*>/g, "")
    .replace(/<\/image>/g, "")
    .trim();
}
