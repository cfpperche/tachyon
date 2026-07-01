/**
 * Codex rollout JSONL -> NormalizedEvent[] (spec 305). Conservative by design: map the record shapes observed
 * in current Codex transcripts and ignore unknown records without throwing.
 */
import type { ActivityEventType, ActivityPayloads, NormalizedEvent } from "./types.js";

interface CodexRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface ActivityNormalizer {
  push(lines: string[]): NormalizedEvent[];
}

interface PendingTool {
  name: string;
}

export function createCodexNormalizer(sourcePath?: string): ActivityNormalizer {
  let seq = 0;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let runtimeVersion: string | undefined;
  const pending = new Map<string, PendingTool>();
  const seenMessages = new Map<string, number>();

  const emit = <T extends ActivityEventType>(
    out: NormalizedEvent[],
    type: T,
    rec: CodexRecord,
    payload: ActivityPayloads[T],
    raw: unknown,
    recordId?: string,
  ): void => {
    out.push({
      type,
      runtime: "codex",
      sequence: seq++,
      sessionId,
      cwd,
      timestamp: rec.timestamp,
      runtimeVersion,
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
        let rec: CodexRecord;
        try {
          rec = JSON.parse(trimmed) as CodexRecord;
        } catch {
          continue;
        }
        const p = rec.payload ?? {};
        if (rec.type === "session_meta") {
          sessionId = str(p.id) ?? str(p.session_id) ?? sessionId;
          cwd = str(p.cwd) ?? cwd;
          runtimeVersion = str(p.cli_version) ?? runtimeVersion;
          continue;
        }
        if (rec.type === "turn_context") {
          cwd = str(p.cwd) ?? cwd;
          continue;
        }
        if (rec.type === "event_msg") {
          handleEventMsg(out, rec, p);
          continue;
        }
        if (rec.type === "response_item") {
          handleResponseItem(out, rec, p);
        }
      }
      return out;
    },
  };

  function handleEventMsg(out: NormalizedEvent[], rec: CodexRecord, p: Record<string, unknown>): void {
    const type = str(p.type);
    if (type === "user_message") {
      const text = str(p.message)?.trim();
      if (text && markMessage("user", rec, text)) emit(out, "user.message.completed", rec, { text }, p, eventId(p));
    } else if (type === "agent_message") {
      const text = str(p.message)?.trim();
      if (text && markMessage("assistant", rec, text)) emit(out, "assistant.message.completed", rec, { text }, p, eventId(p));
    } else if (type === "error") {
      const message = str(p.message) ?? str(p.error) ?? "codex error";
      emit(out, "error", rec, { message }, p, eventId(p));
    } else if (type === "token_count") {
      const usage = tokenUsage(p.info);
      if (usage) emit(out, "usage.updated", rec, usage, p, eventId(p));
    } else if (type === "mcp_tool_call_end") {
      const callId = str(p.call_id);
      const invocation = obj(p.invocation);
      const name = [str(invocation?.server), str(invocation?.tool)].filter(Boolean).join(".") || undefined;
      if (callId) pending.delete(callId);
      emit(out, "tool.completed", rec, { toolUseId: callId, name, summary: resultLabel(p.result), full: shortJson(p.result) }, p, recordIdFor(p, callId));
    } else if (type === "web_search_end") {
      const callId = str(p.call_id);
      if (callId) pending.delete(callId);
      emit(out, "tool.completed", rec, { toolUseId: callId, name: "web_search", summary: str(p.query), full: shortJson(p.action) }, p, recordIdFor(p, callId));
    }
  }

  function handleResponseItem(out: NormalizedEvent[], rec: CodexRecord, p: Record<string, unknown>): void {
    const recordId = str(p.id) ?? str(p.call_id) ?? eventId(p);
    switch (str(p.type)) {
      case "message": {
        const role = str(p.role);
        const text = contentText(p.content).trim();
        if (role === "developer" || role === "system") return;
        if (text && role === "user") {
          if (markMessage("user", rec, text)) emit(out, "user.message.completed", rec, { text }, p, recordId);
        } else if (text && role === "assistant") {
          if (markMessage("assistant", rec, text)) emit(out, "assistant.message.completed", rec, { text }, p, recordId);
        }
        if (role === "user" || role === "assistant") {
          for (const block of contentBlocks(p.content)) {
            const im = imagePayload(block);
            if (im) emit(out, "image.attached", rec, { ...im, from: role === "user" ? "user" : "agent" }, block, recordId);
          }
        }
        break;
      }
      case "reasoning": {
        const text = reasoningText(p.summary).trim();
        if (text) emit(out, "assistant.thinking", rec, { text }, p, recordId);
        break;
      }
      case "function_call": {
        const name = str(p.name) ?? "tool";
        const callId = str(p.call_id) ?? str(p.id);
        const input = parseArgs(p.arguments);
        emit(out, "tool.started", rec, { toolUseId: callId, name, input }, p, recordId);
        if (callId) pending.set(callId, { name });
        break;
      }
      case "function_call_output": {
        const callId = str(p.call_id);
        const tool = callId ? pending.get(callId) : undefined;
        if (callId) pending.delete(callId);
        const full = str(p.output) ?? JSON.stringify(p.output ?? "");
        const summary = summarize(full);
        emit(out, "tool.completed", rec, { toolUseId: callId, name: tool?.name, summary, full }, p, recordId);
        break;
      }
      case "tool_search_call": {
        const callId = str(p.call_id) ?? str(p.id);
        emit(out, "tool.started", rec, { toolUseId: callId, name: "tool_search", input: p.arguments }, p, recordId);
        if (callId) pending.set(callId, { name: "tool_search" });
        break;
      }
      case "tool_search_output": {
        const callId = str(p.call_id);
        if (callId) pending.delete(callId);
        emit(out, "tool.completed", rec, { toolUseId: callId, name: "tool_search", summary: toolSearchSummary(p.tools), full: shortJson(p.tools) }, p, recordId);
        break;
      }
      case "web_search_call": {
        const callId = str(p.call_id) ?? str(p.id);
        emit(out, "tool.started", rec, { toolUseId: callId, name: "web_search", input: p.action }, p, recordId);
        if (callId) pending.set(callId, { name: "web_search" });
        break;
      }
    }
  }

  function markMessage(role: "user" | "assistant", rec: CodexRecord, text: string): boolean {
    const timestamp = Date.parse(rec.timestamp ?? "");
    if (!Number.isFinite(timestamp)) return true;
    const key = `${role}\0${canonicalMessageText(text)}`;
    const prior = seenMessages.get(key);
    if (prior !== undefined && Math.abs(timestamp - prior) <= 2000) return false;
    seenMessages.set(key, timestamp);
    return true;
  }
}

export function normalizeCodex(lines: string[], sourcePath?: string): NormalizedEvent[] {
  return createCodexNormalizer(sourcePath).push(lines);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function canonicalMessageText(text: string): string {
  return stripImageMarkers(text).trim();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .map((b) => {
      return stripImageMarkers(str(b.text) ?? "");
    })
    .filter(Boolean)
    .join("\n");
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
}

function stripImageMarkers(text: string): string {
  return text
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/g, "")
    .replace(/<image\b[^>]*>/g, "")
    .replace(/<\/image>/g, "")
    .trim();
}

function imagePayload(block: Record<string, unknown>): { id: string; mediaType: string } | undefined {
  const source = block.source;
  if (source && typeof source === "object") {
    const s = source as Record<string, unknown>;
    if (s.type === "base64" && typeof s.data === "string") {
      return { id: hashId(s.data), mediaType: typeof s.media_type === "string" ? s.media_type : "image/png" };
    }
  }
  const parsed = parseDataImage(str(block.image_url));
  if (!parsed) return undefined;
  return { id: hashId(parsed.data), mediaType: parsed.mediaType };
}

function parseDataImage(uri: string | undefined): { mediaType: string; data: string } | undefined {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(uri ?? "");
  if (!m) return undefined;
  return { mediaType: m[1] || "image/png", data: m[2] };
}

function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `img_${(h >>> 0).toString(36)}_${s.length}`;
}

function reasoningText(summary: unknown): string {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  return summary
    .map((s) => {
      if (typeof s === "string") return s;
      if (!s || typeof s !== "object") return "";
      const o = s as Record<string, unknown>;
      return str(o.text) ?? str(o.summary) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseArgs(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v) as unknown; } catch { return v; }
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? v as Record<string, unknown> : undefined;
}

function summarize(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

function eventId(p: Record<string, unknown>): string | undefined {
  const turn = str(p.turn_id);
  const type = str(p.type);
  return turn && type ? `${turn}:${type}` : undefined;
}

function recordIdFor(p: Record<string, unknown>, fallback?: string): string | undefined {
  return str(p.id) ?? fallback ?? eventId(p);
}

function resultLabel(v: unknown): string {
  if (!v || typeof v !== "object") return "completed";
  const o = v as Record<string, unknown>;
  if (o.Ok !== undefined) return "ok";
  if (o.Err !== undefined) return "failed";
  return "completed";
}

function shortJson(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  try { return summarize(JSON.stringify(v)); } catch { return undefined; }
}

function toolSearchSummary(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined;
  return `${tools.length} ${tools.length === 1 ? "tool result" : "tool results"}`;
}

function tokenUsage(info: unknown): ActivityPayloads["usage.updated"] | undefined {
  if (!info || typeof info !== "object") return undefined;
  const total = (info as Record<string, unknown>).total_token_usage;
  if (!total || typeof total !== "object") return undefined;
  const o = total as Record<string, unknown>;
  return {
    inputTokens: num(o.input_tokens),
    outputTokens: num(o.output_tokens),
    cacheReadTokens: num(o.cached_input_tokens),
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
