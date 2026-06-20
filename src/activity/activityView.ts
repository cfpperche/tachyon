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
  kind: "message" | "thinking" | "image" | "tool" | "file" | "usage" | "error" | "raw" | "session";
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
  path?: string;
  failed?: boolean;
  timestamp?: string;
}

/** Assistant turn markers that carry no real content (tachyon/claude artifacts) — kept out of the chat. */
const MESSAGE_NOISE = new Set(["No response requested."]);

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

export interface ActivityViewModel {
  runtime?: RuntimeId;
  runtimeVersion?: string;
  sourcePath?: string;
  tier: CapabilityTier;
  /** True when the host's freshness gate failed → the view says "recent activity", not "live". */
  degradedFreshness?: boolean;
  summary: ActivitySummary;
  items: ActivityItem[];
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
        const text = (e.payload as { text: string }).text;
        items.push({ sequence: e.sequence, kind: "message", role: "user", title: text, timestamp: e.timestamp });
        break;
      }
      case "assistant.message.completed": {
        const text = (e.payload as { text: string }).text;
        if (MESSAGE_NOISE.has(text.trim())) break; // a turn marker, not real content
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
      case "error": {
        const p = e.payload as { message: string };
        items.push({ sequence: e.sequence, kind: "error", title: p.message, failed: true, timestamp: e.timestamp });
        break;
      }
      case "raw":
        // Kept out of the primary feed by default (it's the escape-hatch); the view can reveal it on demand.
        break;
    }
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
  });

  return { push, view };
}
