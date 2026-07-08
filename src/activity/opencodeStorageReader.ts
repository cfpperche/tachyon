import * as fs from "node:fs";
import * as path from "node:path";
import { createOpencodeNormalizer, type OpencodeMessageRecord, type OpencodePartRecord, type OpencodeTurnRecord } from "./opencodeNormalizer.js";
import { ActivityLog } from "./logStore.js";
import type { NormalizedEvent } from "./types.js";

interface OpencodeReaderSessionState {
  seenParts: Record<string, true>;
}

export interface OpencodeReaderState {
  opencode?: {
    sessions: Record<string, OpencodeReaderSessionState>;
  };
}

export class OpencodeStorageReader {
  private readonly normalizer = createOpencodeNormalizer();

  constructor(
    private readonly log: ActivityLog,
    private readonly state: OpencodeReaderState,
    private readonly now: () => string,
  ) {}

  resetSession(sessionId: string): void {
    delete this.state.opencode?.sessions[sessionId];
  }

  poll(storageRoot: string, sessionId: string): number {
    const session = readSession(storageRoot, sessionId);
    if (!session) return 0;
    const root = this.state.opencode ??= { sessions: {} };
    const st = root.sessions[sessionId] ??= { seenParts: {} };
    st.seenParts ??= {};
    let appended = 0;
    for (const turn of readTurns(storageRoot, sessionId)) {
      const unseenParts = turn.parts.filter((part) => part.id && !st.seenParts[part.id]);
      if (unseenParts.length === 0) continue;
      const recordId = `${turn.message.id ?? "message"}:${unseenParts.map((p) => p.id).join(",")}`;
      const events = this.normalizer.push([{ ...turn, parts: unseenParts }]).filter((e) => e.type !== "raw");
      if (events.length > 0) {
        appended += this.log.appendRecord(
          events,
          { runtime: "opencode", sessionId, sourcePath: turn.sourcePath, recordId },
          this.now(),
          collectBlobs(events),
        );
      }
      for (const part of unseenParts) if (part.id) st.seenParts[part.id] = true;
    }
    return appended;
  }
}

function readSession(storageRoot: string, sessionId: string): unknown | undefined {
  try {
    const sessionRoot = path.join(storageRoot, "session");
    for (const project of fs.readdirSync(sessionRoot)) {
      const file = path.join(sessionRoot, project, `${sessionId}.json`);
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readTurns(storageRoot: string, sessionId: string): OpencodeTurnRecord[] {
  const messages = readMessages(storageRoot, sessionId);
  const partsByMessage = readParts(storageRoot, sessionId);
  return messages
    .map((message) => ({ message, parts: partsByMessage.get(message.id ?? "") ?? [], sourcePath: messageSourcePath(storageRoot, sessionId, message.id) }))
    .filter((turn) => turn.parts.length > 0)
    .sort((a, b) => createdMs(a.message) - createdMs(b.message));
}

function readMessages(storageRoot: string, sessionId: string): OpencodeMessageRecord[] {
  const dir = path.join(storageRoot, "message", sessionId);
  const out: OpencodeMessageRecord[] = [];
  for (const file of jsonFiles(dir)) {
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8")) as OpencodeMessageRecord;
      if (rec.sessionID === sessionId && typeof rec.id === "string") out.push(rec);
    } catch {
      /* skip partial/unreadable files */
    }
  }
  return out;
}

function readParts(storageRoot: string, sessionId: string): Map<string, OpencodePartRecord[]> {
  const byMessage = new Map<string, OpencodePartRecord[]>();
  const root = path.join(storageRoot, "part");
  for (const msgDir of dirs(root)) {
    for (const file of jsonFiles(msgDir)) {
      try {
        const rec = JSON.parse(fs.readFileSync(file, "utf8")) as OpencodePartRecord;
        if (rec.sessionID !== sessionId || typeof rec.messageID !== "string") continue;
        const arr = byMessage.get(rec.messageID) ?? [];
        arr.push(rec);
        byMessage.set(rec.messageID, arr);
      } catch {
        /* skip partial/unreadable files */
      }
    }
  }
  for (const arr of byMessage.values()) arr.sort((a, b) => partOrder(a) - partOrder(b));
  return byMessage;
}

function dirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

function jsonFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function createdMs(message: OpencodeMessageRecord): number {
  return typeof message.time?.created === "number" ? message.time.created : 0;
}

function partOrder(part: OpencodePartRecord): number {
  if (typeof part.time?.created === "number") return part.time.created;
  const m = /(\d+)(?=\.json$|$)/.exec(part.id ?? "");
  return m ? Number(m[1]) : 0;
}

function messageSourcePath(storageRoot: string, sessionId: string, messageId: string | undefined): string | undefined {
  return messageId ? path.join(storageRoot, "message", sessionId, `${messageId}.json`) : undefined;
}

function collectBlobs(events: NormalizedEvent[]): Map<string, Buffer> | undefined {
  let m: Map<string, Buffer> | undefined;
  for (const ev of events) {
    if (ev.type !== "image.attached") continue;
    const id = (ev.payload as { id?: string }).id;
    const data = imageDataFromRaw(ev.raw);
    if (id && typeof data === "string") (m ??= new Map()).set(id, Buffer.from(data, "base64"));
  }
  return m;
}

function imageDataFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as { source?: { data?: string }; image_url?: string };
  if (typeof rec.source?.data === "string") return rec.source.data;
  const m = /^data:[^;,]+;base64,(.+)$/s.exec(rec.image_url ?? "");
  return m?.[1];
}
