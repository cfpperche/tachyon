import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  isWorkspaceEventV1,
  type WorkspaceEventBatchV1,
  type WorkspaceEventV1,
} from "./protocol.js";

const DEFAULT_MAX_EVENTS = 1_024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;

export interface EngineEventJournalOptions {
  filePath: string;
  engineInstanceId: string;
  maxEvents?: number;
}

export class EngineEventJournal {
  private events: WorkspaceEventV1[];
  private readonly maxEvents: number;

  constructor(private readonly options: EngineEventJournalOptions) {
    if (options.engineInstanceId.length < 8 || options.engineInstanceId.length > 128) throw new Error("invalid engine event identity");
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents <= 0) throw new Error("event journal maxEvents must be a positive integer");
    ensurePrivateDirectory(path.dirname(options.filePath));
    this.events = readJournal(options.filePath, options.engineInstanceId);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
      rewriteJournal(options.filePath, this.events);
    }
  }

  get latestSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  append(kind: string, payload: Record<string, unknown>, at = new Date().toISOString()): WorkspaceEventV1 {
    const event: WorkspaceEventV1 = {
      schemaVersion: 1,
      engineInstanceId: this.options.engineInstanceId,
      seq: this.latestSeq + 1,
      at,
      kind,
      payload: clonePayload(payload),
    };
    if (!isWorkspaceEventV1(event)) throw new Error("engine event violates the event protocol");
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) throw new Error("engine event exceeds the size limit");
    const next = [...this.events, event];
    if (next.length > this.maxEvents) {
      const compacted = next.slice(-this.maxEvents);
      rewriteJournal(this.options.filePath, compacted);
      this.events = compacted;
    } else {
      const previousSize = fileSize(this.options.filePath);
      try {
        fs.appendFileSync(this.options.filePath, line, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(this.options.filePath, 0o600);
      } catch (error) {
        try { fs.truncateSync(this.options.filePath, previousSize); } catch { /* preserve the original error */ }
        throw error;
      }
      this.events = next;
    }
    return cloneEvent(event);
  }

  readAfter(afterSeq: number, limit = 100): WorkspaceEventBatchV1 {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("event cursor must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) throw new Error("event read limit must be between 1 and 200");
    const latestSeq = this.latestSeq;
    const oldestSeq = this.events[0]?.seq ?? latestSeq + 1;
    const resyncRequired = afterSeq > latestSeq || afterSeq < oldestSeq - 1;
    const events = resyncRequired
      ? []
      : this.events.filter((event) => event.seq > afterSeq).slice(0, limit).map(cloneEvent);
    return {
      schemaVersion: 1,
      engineInstanceId: this.options.engineInstanceId,
      afterSeq,
      oldestSeq,
      latestSeq,
      resyncRequired,
      events,
    };
  }
}

function fileSize(file: string): number {
  try { return fs.statSync(file).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * t-c6a89e — parse a journal file WITHOUT owning it.
 *
 * Constructing `EngineEventJournal` is not a read: it creates the parent directory and, past
 * `maxEvents`, rewrites the file. A second process doing that to a single-writer log (t-d5066b) is
 * the corruption this export exists to avoid, so a reader that must not own the file gets the parse —
 * including every safety check on it: regular file, size cap, ownership and mode, and a refusal of
 * foreign or out-of-order events.
 *
 * Returns `[]` for a file that does not exist. Callers that need to tell "absent" from "empty" must
 * stat it themselves, because those are different facts and this cannot tell them apart.
 */
export function readEngineEventJournal(file: string, engineInstanceId: string): WorkspaceEventV1[] {
  return readJournal(file, engineInstanceId);
}

function readJournal(file: string, engineInstanceId: string): WorkspaceEventV1[] {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("engine event journal is not a regular file");
  if (stat.size > MAX_JOURNAL_BYTES) throw new Error("engine event journal exceeds the size limit");
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) throw new Error("engine event journal has unsafe permissions");
  }
  const content = fs.readFileSync(file, "utf8");
  const complete = content.endsWith("\n") ? content : content.slice(0, Math.max(0, content.lastIndexOf("\n") + 1));
  const output: WorkspaceEventV1[] = [];
  for (const line of complete.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as unknown;
    if (!isWorkspaceEventV1(event) || event.engineInstanceId !== engineInstanceId) {
      throw new Error("engine event journal contains an invalid or foreign event");
    }
    const previous = output.at(-1);
    if (previous && event.seq !== previous.seq + 1) throw new Error("engine event journal sequence is not contiguous");
    output.push(event);
  }
  if (complete !== content) rewriteJournal(file, output);
  return output;
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("engine event journal directory is unsafe");
  if (process.platform === "win32") return;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error("engine event journal directory is unsafe");
  }
}

function rewriteJournal(file: string, events: WorkspaceEventV1[]): void {
  const encoded = events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed or already absent */ }
  }
}

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(payload)) as unknown;
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) throw new Error("engine event payload must be a JSON object");
  return cloned as Record<string, unknown>;
}

function cloneEvent(event: WorkspaceEventV1): WorkspaceEventV1 {
  return { ...event, payload: clonePayload(event.payload) };
}
