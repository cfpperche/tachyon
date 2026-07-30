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
import { readForward, readTailWindow } from "./tailReader.js";
import type { NormalizedEvent } from "./types.js";

export const LOG_SCHEMA_VERSION = 1;

/** Bound the idempotency hydrate to the last N records — the dedup only needs to cover the crash-recovery
 *  window (append succeeded but the writer's offset wasn't saved), not the whole durable archive. Keeps both
 *  the startup scan AND the in-memory `seen` set bounded on a long-lived log (codex MAJOR). */
const HYDRATE_KEYS = 8000;

/** A collision-proof, filesystem-safe file id for an agent name. A lossy sanitize alone would map distinct
 *  names (`foo/bar`, `foo bar`, `foo_bar`) to the same file; the sha256 suffix disambiguates (codex MAJOR). */
export function agentLogId(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
  return `${safe}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`; // 16 hex = collision-proof in practice
}

/** Delete an agent's durable activity log + its writer-state sidecar. Called when an agent is removed
 *  from the ledger as a by-design NON-PERSISTENT one (a clean-exit Temporary one-shot, or an inline pipeline
 *  `cmd:` node): spec 239's log is the durable archive OF A DURABLE AGENT, keyed by the tachyon agent, so a
 *  reaped ephemeral must not leave an orphaned, unreachable `.jsonl` growing under `.tachyon/activity/` (the
 *  Activity panel only opens per LIVE sidebar row, so the file is invisible once the row is gone) — pin
 *  p-4dadd3 decision (a). The log's lifecycle thus equals the ledger row's. Best-effort; never throws.
 *  Shared content-addressed blobs under `blobs/` are NOT touched (other agents may reference them — GC is
 *  a separate concern). */
export function deleteActivityLog(dir: string, agent: string): void {
  const base = path.join(dir, agentLogId(agent));
  for (const f of [`${base}.jsonl`, `${base}.state.json`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* best-effort: a missing/locked file is fine */ }
  }
}

/** Move an agent's durable activity log + writer-state sidecar when the agent row is renamed. Best-effort;
 *  never throws. Shared content-addressed blobs under `blobs/` are NOT touched. */
export function moveActivityLog(dir: string, fromAgent: string, toAgent: string): void {
  if (fromAgent === toAgent) return;
  const fromBase = path.join(dir, agentLogId(fromAgent));
  const toBase = path.join(dir, agentLogId(toAgent));
  for (const ext of [".jsonl", ".state.json"]) {
    const from = `${fromBase}${ext}`;
    const to = `${toBase}${ext}`;
    try {
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
    } catch {
      /* best-effort: a missing/locked file is fine */
    }
  }
}

export interface ActivityRenameSnapshot {
  jsonlSha256: string | null;
  stateSha256: string | null;
}

function fileDigest(file: string): string | null {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function captureActivityRenameSnapshot(dir: string, agent: string): ActivityRenameSnapshot {
  const base = path.join(dir, agentLogId(agent));
  return {
    jsonlSha256: fileDigest(`${base}.jsonl`),
    stateSha256: fileDigest(`${base}.state.json`),
  };
}

/** Exact source/target pair-state move used by recoverable canonical rename. */
export function convergeActivityRename(
  dir: string,
  fromAgent: string,
  toAgent: string,
  expected: ActivityRenameSnapshot,
): void {
  const fromBase = path.join(dir, agentLogId(fromAgent));
  const toBase = path.join(dir, agentLogId(toAgent));
  for (const [ext, expectedDigest] of [[".jsonl", expected.jsonlSha256], [".state.json", expected.stateSha256]] as const) {
    const from = `${fromBase}${ext}`;
    const to = `${toBase}${ext}`;
    const sourceDigest = fileDigest(from);
    const targetDigest = fileDigest(to);
    if (sourceDigest === null && targetDigest === null) {
      if (expectedDigest !== null) throw new Error(`activity rename lost captured '${ext}' state`);
      continue;
    }
    // A live writer may append or create its state after intent. Destination absence was captured
    // before commit, so exact source/absent-target remains the owned move; absent-source/target
    // acknowledges the same inode move after an uncertain return.
    if (sourceDigest === null && targetDigest !== null) continue;
    if (sourceDigest === null || targetDigest !== null) {
      throw new Error(`activity rename '${ext}' changed outside the transaction`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    if (fileDigest(from) !== null || fileDigest(to) !== sourceDigest) throw new Error(`activity rename '${ext}' did not converge`);
  }
}

/** Move exact activity bytes into an identity-qualified retirement quarantine. */
export function convergeActivityRetirement(
  dir: string,
  agent: string,
  expected: ActivityRenameSnapshot,
  quarantineDir: string,
): void {
  const sourceBase = path.join(dir, agentLogId(agent));
  fs.mkdirSync(quarantineDir, { recursive: true });
  for (const [ext, expectedDigest] of [[".jsonl", expected.jsonlSha256], [".state.json", expected.stateSha256]] as const) {
    const source = `${sourceBase}${ext}`;
    const destination = path.join(quarantineDir, `activity${ext}`);
    const sourceDigest = fileDigest(source);
    const destinationDigest = fileDigest(destination);
    if (sourceDigest === null && destinationDigest === expectedDigest) continue;
    if (expectedDigest === null && sourceDigest === null && destinationDigest === null) continue;
    if (sourceDigest !== expectedDigest || destinationDigest !== null) {
      throw new Error(`activity retirement '${ext}' changed outside the transaction`);
    }
    fs.renameSync(source, destination);
    if (fileDigest(source) !== null || fileDigest(destination) !== expectedDigest) {
      throw new Error(`activity retirement '${ext}' did not converge`);
    }
  }
}

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
  /** spec 378 — hoisted like `runtimeVersion` (additive; no schemaVersion bump). */
  model?: string;
  effort?: string;
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
  /** spec 378 — hoisted like `runtimeVersion` (additive; no schemaVersion bump). */
  model?: string;
  effort?: string;
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
  private blobSeq = 0; // disambiguates concurrent blob temp files

  constructor(dir: string, agent: string) {
    this.file = path.join(dir, `${agentLogId(agent)}.jsonl`);
    this.blobDir = path.join(dir, "blobs");
  }

  /** Build the idempotency set from the LAST `HYDRATE_KEYS` records (bounded — the dedup only needs the
   *  crash-recovery window, not the whole archive). Lazy + once. A torn final line fails JSON.parse and is
   *  skipped → that record is re-appended next run (no loss, no dup). */
  hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    let lines: string[];
    try { lines = readTailWindow(this.file, HYDRATE_KEYS).lines; } catch { return; }
    for (const line of lines) {
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
      ...(f.model !== undefined ? { model: f.model } : {}),
      ...(f.effort !== undefined ? { effort: f.effort } : {}),
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
    return this.tailFrom(n).events;
  }

  /** Bounded initial read: the last `n` records' events + a forward cursor (offset + byte partial) to continue
   *  from, plus `startOffset` (the byte where the window begins — `>0` means older records exist on disk, for
   *  backward paging). The render panel uses this to open then `forwardFrom` for live appends (same seam as inc 2). */
  tailFrom(n: number): { events: LoggedEvent[]; offset: number; partial: Buffer; startOffset: number } {
    let win;
    try { win = readTailWindow(this.file, n); } catch { return { events: [], offset: 0, partial: Buffer.alloc(0), startOffset: 0 }; }
    return { events: flatten(win.lines), offset: win.endOffset, partial: win.partial, startOffset: win.startOffset };
  }

  /** Read events appended to the log since `offset` (carrying `partial` bytes) + the new cursor. */
  forwardFrom(offset: number, partial: Buffer): { events: LoggedEvent[]; offset: number; partial: Buffer } {
    let fwd;
    try { fwd = readForward(this.file, offset, partial); } catch { return { events: [], offset, partial }; }
    return { events: flatten(fwd.lines), offset: fwd.endOffset, partial: fwd.partial };
  }

  /** Current byte size of the log (0 if it doesn't exist yet) — the render panel uses it to detect growth. */
  size(): number {
    try { return fs.statSync(this.file).size; } catch { return 0; }
  }

  /** Copy a rendered blob, content-addressed by sha256 (true content addressing) via a UNIQUE temp + rename.
   *  Returns the digest used as `blobRef` + filename. Identical bytes dedup to the same file; a second writer
   *  (another window/host) publishing the same digest is tolerated (we just drop our temp). */
  putBlob(data: Buffer): string {
    const digest = createHash("sha256").update(data).digest("hex");
    const p = this.blobPath(digest);
    if (fs.existsSync(p)) return digest; // already published (content-addressed — identical bytes)
    fs.mkdirSync(this.blobDir, { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${this.blobSeq++}`; // unique → no cross-writer temp clash
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, p); // atomic publish — a reader never sees a partial blob
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (!fs.existsSync(p)) throw e; // a REAL failure (ENOSPC/EACCES/EXDEV) — surface it; don't leave a dangling blobRef
      // else: another writer won the publish race — the digest is present, fine
    }
    return digest;
  }

  blobPath(digest: string): string {
    return path.join(this.blobDir, sanitize(digest));
  }
}

/** Parse persisted record lines (one per source record) → flattened LoggedEvents (shared fields applied). */
function flatten(lines: string[]): LoggedEvent[] {
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
        ...(r.model !== undefined ? { model: r.model } : {}),
        ...(r.effort !== undefined ? { effort: r.effort } : {}),
        payload: e.payload, source: r.source, ...(e.blobRef ? { blobRef: e.blobRef } : {}), loggedAt: r.loggedAt,
      });
    }
  }
  return out;
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
