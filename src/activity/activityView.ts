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
  kind: "message" | "tool" | "file" | "usage" | "error" | "raw" | "session";
  /** For chat bubbles: who spoke. "user" → right, "agent" → left; absent for non-message activity. */
  role?: "user" | "agent";
  title: string;
  detail?: string;
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

const uniq = (xs: string[]): string[] => [...new Set(xs)];

export function buildActivityView(
  events: NormalizedEvent[],
  opts: { tier?: CapabilityTier; degradedFreshness?: boolean } = {},
): ActivityViewModel {
  const items: ActivityItem[] = [];
  const changed: string[] = [];
  const referenced: string[] = [];
  const startedTools = new Set<string>();
  const toolName = new Map<string, string>();
  let messages = 0;
  let toolsFailed = 0;
  let inTok = 0;
  let outTok = 0;
  let lastActivity: string | undefined;

  for (const e of events) {
    if (e.timestamp) lastActivity = e.timestamp;
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
        messages++;
        const text = (e.payload as { text: string }).text;
        items.push({ sequence: e.sequence, kind: "message", role: "agent", title: text, timestamp: e.timestamp });
        break;
      }
      case "tool.started": {
        const p = e.payload as { toolUseId?: string; name: string };
        if (p.toolUseId) { startedTools.add(p.toolUseId); toolName.set(p.toolUseId, p.name); }
        items.push({ sequence: e.sequence, kind: "tool", title: p.name, detail: "running", timestamp: e.timestamp });
        break;
      }
      case "tool.completed": {
        const p = e.payload as { toolUseId?: string };
        if (p.toolUseId) startedTools.delete(p.toolUseId);
        break;
      }
      case "tool.failed": {
        const p = e.payload as { toolUseId?: string; name?: string; message?: string };
        const name = p.name ?? (p.toolUseId ? toolName.get(p.toolUseId) : undefined) ?? "tool";
        if (p.toolUseId) startedTools.delete(p.toolUseId);
        toolsFailed++;
        items.push({ sequence: e.sequence, kind: "tool", title: name, detail: p.message ?? "failed", failed: true, timestamp: e.timestamp });
        break;
      }
      case "file.changed": {
        const p = e.payload as { path: string; tool?: string };
        changed.push(p.path);
        items.push({ sequence: e.sequence, kind: "file", title: p.path, detail: p.tool ? `changed · ${p.tool}` : "changed", path: p.path, timestamp: e.timestamp });
        break;
      }
      case "file.referenced": {
        const p = e.payload as { path: string; tool?: string };
        referenced.push(p.path);
        items.push({ sequence: e.sequence, kind: "file", title: p.path, detail: p.tool ? `read · ${p.tool}` : "read", path: p.path, timestamp: e.timestamp });
        break;
      }
      case "file.snapshot":
        break; // summary-only signal in v1 (not proof THIS agent changed a file)
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

  const last = events[events.length - 1];
  return {
    runtime: last?.runtime,
    runtimeVersion: events.find((e) => e.runtimeVersion)?.runtimeVersion,
    sourcePath: events.find((e) => e.sourcePath)?.sourcePath,
    tier: opts.tier ?? "structured",
    degradedFreshness: opts.degradedFreshness,
    summary: {
      messages,
      toolsRunning: startedTools.size,
      toolsFailed,
      filesChanged: uniq(changed),
      filesReferenced: uniq(referenced),
      tokens: { input: inTok, output: outTok },
      lastActivity,
    },
    items,
  };
}
