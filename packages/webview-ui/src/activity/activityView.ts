import type { CapabilityTier, NormalizedEvent, RuntimeId } from "@tachyon/engine/activity/types.js";
/** One render-ready feed entry. `kind` drives the icon/treatment; `path` (when set) is clickable. */
export interface ActivityItem {
  sequence: number;
  kind: "message" | "command" | "nudge" | "injected" | "thinking" | "image" | "tool" | "file" | "usage" | "error" | "raw" | "session" | "boundary";
  /** Finer treatment within a kind — e.g. an interrupt boundary is toned warn, distinct from routine compaction. */
  variant?: "interrupted";
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


export interface ActivityBuilder {
  /** Fold only the NEWLY-appended events into the running model (O(new), not O(all)) — the host calls this
   *  with each tail chunk so a long session never re-walks the whole event log per render. */
  push(events: NormalizedEvent[]): void;
  /** Snapshot the current view-model. `items` is the live array (the host slices it; it never mutates it). */
  view(opts?: { tier?: CapabilityTier; degradedFreshness?: boolean }): ActivityViewModel;
}
