/**
 * Durable, normalized, append-only activity log for ONE tachyon agent (spec 239 inc 3). It is BOTH the
 * render source and the durable archive: it survives /clear, /resume, fresh starts, and runtime-side pruning,
 * because it lives under `.tachyon/activity/` keyed by the tachyon AGENT — not by the runtime's (cwd, uuid).
 *
 * NOT a raw clone (D1/D2): we persist NORMALIZED events (the render spine) with `raw` STRIPPED, plus a
 * provenance `source` pointer back to the canonical record (prefer the record uuid), plus content-addressed
 * copies of the blobs we actually render (images). Every line carries `schemaVersion` (D8).
 *
 * Crash-atomic per SOURCE RECORD: one JSONL line holds ALL events of one source record, so a crash mid-write
 * leaves an unparseable trailing line (skipped on the next read) — never a half-logged record that idempotency
 * would then suppress forever (codex BLOCKER fold). Idempotency (R5): a record already in the log is skipped.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { readTailWindow } from "./tailReader.js";
import type { NormalizedEvent } from "./types.js";

export const LOG_SCHEMA_VERSION = 1;

/** Provenance back to the canonical runtime record. `recordId` (the runtime's stable per-record id) is
 *  preferred; `byteOffset` is a locator fallback only. */
export interface LogSource {
  runtime: string;
  sessionId?: string;
  recordId?: string;
  byteOffset?: number;
  sourcePath?: string;
}

/** One persisted line = all events of ONE source record (atomic). Shared fields are hoisted off the events. */
export interface LoggedRecord {
  schemaVersion: number;
  source: LogSource;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  runtimeVersion?: string;
  loggedAt: string;
  events: Array<{ type: string; payload: unknown; blobRef?: string }>;
}

/** A flattened logged event (what `readTail` yields) — a record's shared fields applied to each of its events. */
export interface LoggedEvent {
  schemaVersion: number;
  type: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  runtimeVersion?: string;
  payload: unknown;
  source: LogSource;
  /** sha256 of a copied blob (an image we render) under `blobs/` — survives runtime pruning. */
  blobRef?: string;
  loggedAt: string;
}

export class ActivityLog {
  readonly file: string;
  readonly blobDir: string;
  private readonly seen = new Set<string>(); // record keys already persisted (idempotency)
  private hydrated = false;
  private tailClean = false; // has the trailing-newline boundary been healed for this writer?

  constructor(dir: string, agent: string) {
    this.file = path.join(dir, `${sanitize(agent)}.jsonl`);
    this.blobDir = path.join(dir, "blobs");
  }

  /** Build the idempotency set from the existing log (record keys). Lazy + once. A torn final line (crash
   *  mid-append) fails JSON.parse and is skipped → that record is re-appended next run (no loss, no dup). */
  hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); } catch { return; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { const k = recordKey((JSON.parse(line) as LoggedRecord).source); if (k) this.seen.add(k); } catch { /* torn/bad line */ }
    }
  }

  /** True once this source record has been persisted (after hydrate / a prior append). */
  hasRecord(source: LogSource): boolean {
    this.hydrate();
    const k = recordKey(source);
    return k ? this.seen.has(k) : false;
  }

  /**
   * Persist the events produced by ONE source record as a single atomic JSONL line — idempotent. Returns the
   * number of events written (0 if the record was already logged, or there were none). `blobs` (payload id →
   * bytes) supplies the raw bytes for any image event, copied once (content-addressed by sha256).
   */
  appendRecord(events: NormalizedEvent[], source: LogSource, loggedAt: string, blobs?: Map<string, Buffer>): number {
    this.hydrate();
    if (events.length === 0) return 0;
    const key = recordKey(source);
    if (key && this.seen.has(key)) return 0; // idempotent: this record is already in the log

    const entries = events.map((ev) => {
      const id = ev.type === "image.attached" ? (ev.payload as { id?: string }).id : undefined;
      const data = id ? blobs?.get(id) : undefined;
      const blobRef = data ? this.putBlob(data) : undefined; // sha256 content-address
      return { type: ev.type, payload: ev.payload /* `raw` intentionally dropped */, ...(blobRef ? { blobRef } : {}) };
    });
    const f = events[0]; // all events of one record share these
    const record: LoggedRecord = {
      schemaVersion: LOG_SCHEMA_VERSION,
      source,
      ...(f.sessionId !== undefined ? { sessionId: f.sessionId } : {}),
      ...(f.cwd !== undefined ? { cwd: f.cwd } : {}),
      ...(f.timestamp !== undefined ? { timestamp: f.timestamp } : {}),
      ...(f.runtimeVersion !== undefined ? { runtimeVersion: f.runtimeVersion } : {}),
      loggedAt,
      events: entries,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.healTail(); // a prior crash may have left a newline-less partial — never concatenate onto it
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8"); // ONE line — atomic per record
    if (key) this.seen.add(key);
    return entries.length;
  }

  /** Once per writer: if the log ends with a torn (newline-less) partial line from a crash, terminate it with
   *  a newline so the next append lands on its own line (the torn line stays unparseable → skipped on read). */
  private healTail(): void {
    if (this.tailClean) return;
    this.tailClean = true;
    try {
      const size = fs.statSync(this.file).size;
      if (size === 0) return;
      const fd = fs.openSync(this.file, "r");
      const b = Buffer.alloc(1);
      try { fs.readSync(fd, b, 0, 1, size - 1); } finally { fs.closeSync(fd); }
      if (b[0] !== 0x0a) fs.appendFileSync(this.file, "\n");
    } catch { /* no file yet */ }
  }

  /** The last events spanning the last `n` records, oldest→newest (reuses the inc-2 backward reader). */
  readTail(n: number): LoggedEvent[] {
    let lines: string[];
    try { lines = readTailWindow(this.file, n).lines; } catch { return []; }
    const out: LoggedEvent[] = [];
    for (const line of lines) {
      let r: LoggedRecord;
      try { r = JSON.parse(line) as LoggedRecord; } catch { continue; }
      if (!Array.isArray(r.events)) continue;
      for (const e of r.events) {
        out.push({
          schemaVersion: r.schemaVersion, type: e.type,
          ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
          ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
          ...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}),
          ...(r.runtimeVersion !== undefined ? { runtimeVersion: r.runtimeVersion } : {}),
          payload: e.payload, source: r.source, ...(e.blobRef ? { blobRef: e.blobRef } : {}), loggedAt: r.loggedAt,
        });
      }
    }
    return out;
  }

  /** Copy a rendered blob, content-addressed by sha256 (true content addressing) via an atomic temp+rename.
   *  Returns the digest used as `blobRef` + filename. Identical bytes dedup to the same file. */
  putBlob(data: Buffer): string {
    const digest = createHash("sha256").update(data).digest("hex");
    const p = this.blobPath(digest);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(this.blobDir, { recursive: true });
      const tmp = `${p}.tmp`; // single writer per agent (D9) → no concurrent temp clash
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p); // atomic publish — a reader never sees a partial blob
    }
    return digest;
  }

  blobPath(digest: string): string {
    return path.join(this.blobDir, sanitize(digest));
  }
}

/** Per-record idempotency key: runtime + session + (recordId | byteOffset). undefined when neither id exists. */
function recordKey(s: LogSource): string | undefined {
  const id = s.recordId ?? (typeof s.byteOffset === "number" ? `@${s.byteOffset}` : undefined);
  return id ? `${s.runtime}:${s.sessionId ?? ""}:${id}` : undefined;
}

/** Filesystem-safe component (agent name / blob digest never escape the activity dir). */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
