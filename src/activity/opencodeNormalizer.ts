import type { ActivityEventType, ActivityPayloads, NormalizedEvent } from "./types.js";

export interface OpencodeMessageRecord {
  id?: string;
  sessionID?: string;
  role?: string;
  time?: { created?: number };
  agent?: string;
  model?: { providerID?: string; modelID?: string };
  summary?: { title?: string };
}

export interface OpencodePartRecord {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  time?: { created?: number };
  tool?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface OpencodeTurnRecord {
  message: OpencodeMessageRecord;
  parts: OpencodePartRecord[];
  sourcePath?: string;
}

export interface OpencodeNormalizer {
  push(records: OpencodeTurnRecord[]): NormalizedEvent[];
}

export function createOpencodeNormalizer(sourcePath?: string): OpencodeNormalizer {
  let seq = 0;

  const emit = <T extends ActivityEventType>(
    out: NormalizedEvent[],
    type: T,
    rec: OpencodeTurnRecord,
    payload: ActivityPayloads[T],
    raw: unknown,
    recordId?: string,
  ): void => {
    const model = modelLabel(rec.message);
    out.push({
      type,
      runtime: "opencode",
      sequence: seq++,
      sessionId: rec.message.sessionID,
      timestamp: timestamp(rec),
      ...(model ? { model } : {}),
      recordId,
      sourcePath: rec.sourcePath ?? sourcePath,
      payload,
      raw,
    });
  };

  return {
    push(records: OpencodeTurnRecord[]): NormalizedEvent[] {
      const out: NormalizedEvent[] = [];
      for (const rec of records) {
        const role = rec.message.role;
        for (const part of rec.parts) emitToolPart(out, rec, part);
        const text = textParts(rec.parts).join("\n").trim();
        if (!text) continue;
        const recordId = rec.message.id ?? rec.parts.map((p) => p.id).find(Boolean);
        if (role === "user") emit(out, "user.message.completed", rec, { text }, rec, recordId);
        else if (role === "assistant") emit(out, "assistant.message.completed", rec, { text }, rec, recordId);
      }
      return out;
    },
  };

  function emitToolPart(out: NormalizedEvent[], rec: OpencodeTurnRecord, part: OpencodePartRecord): void {
    const type = part.type ?? "";
    if (!/tool/i.test(type)) return;
    const name = part.name ?? part.tool ?? "tool";
    const id = part.id;
    if (/result|output|complete|finish/i.test(type)) {
      const full = stringify(part.output ?? part.result ?? part.error ?? part.text);
      emit(out, part.error ? "tool.failed" : "tool.completed", rec, { toolUseId: id, name, summary: summarize(full), full }, part, id);
    } else {
      emit(out, "tool.started", rec, { toolUseId: id, name, input: part.input }, part, id);
    }
  }
}

export function normalizeOpencode(records: OpencodeTurnRecord[], sourcePath?: string): NormalizedEvent[] {
  return createOpencodeNormalizer(sourcePath).push(records);
}

function textParts(parts: OpencodePartRecord[]): string[] {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .filter((s) => s.trim().length > 0);
}

function timestamp(rec: OpencodeTurnRecord): string | undefined {
  const ms = rec.message.time?.created ?? rec.parts.map((p) => p.time?.created).find((v): v is number => typeof v === "number");
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function modelLabel(message: OpencodeMessageRecord): string | undefined {
  const provider = message.model?.providerID;
  const model = message.model?.modelID;
  return [provider, model].filter((s): s is string => typeof s === "string" && s.length > 0).join("/") || undefined;
}

function stringify(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function summarize(text: string | undefined): string | undefined {
  const s = text?.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}
