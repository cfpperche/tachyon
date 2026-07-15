/**
 * Always-on durable-log writer for ONE tachyon agent (spec 239 inc 3b). Tails the agent's CURRENT runtime
 * session forward into the per-agent `ActivityLog`; when the session uuid changes (a /clear, /resume, or fresh
 * start rotates the file) it emits ONE `session.boundary` and continues in the SAME log — so the per-agent log
 * stitches every session the agent owns, observed AS IT HAPPENS (codex: unobserved rotation is the real loss,
 * not pruning). A per-session byte offset is persisted so re-activation resumes without re-reading or
 * duplicating; record-level idempotency in `ActivityLog` covers a crash between append and offset-save.
 *
 * Pull-based + sync: the host resolves the current session (async) and calls `poll(cur)` on a timer; the writer
 * itself has no timers/async, so it is unit-testable with a fake `cur`. Conservative on ambiguity: `cur ===
 * undefined` (no session, gone, or shared-cwd suppressed) is a GAP — it writes nothing, never guesses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ActivityLog, agentLogId } from "./logStore.js";
import { createClaudeNormalizer } from "./claudeNormalizer.js";
import { createCodexNormalizer, type ActivityNormalizer } from "./codexNormalizer.js";
import { createGrokNormalizer } from "./grokNormalizer.js";
import { HermesStorageReader, type HermesReaderState } from "./hermesStorageReader.js";
import { OpencodeStorageReader, type OpencodeReaderState } from "./opencodeStorageReader.js";
import { readForward, readTailWindow } from "./tailReader.js";
import type { NormalizedEvent } from "./types.js";

/** First time a session is seen, capture only its recent tail (not a 180MB-class backfill that would block
 *  activation) — the deep history stays in the runtime file (reachable via "Open transcript"). From then on
 *  everything appended is logged. Consistent with "lineage starts now". */
const MAX_BACKFILL_RECORDS = 4000;

/** Polls to wait before emitting a STANDALONE lifecycle marker (only for actions that validly keep the same
 *  uuid, i.e. a seamless resume). At ~2s/poll this is a few seconds. */
const LIFECYCLE_GRACE_POLLS = 3;
/** Backstop: drop a still-unconsumed pending action after this many polls so it can never label a much-later
 *  unrelated session change. The normal path consumes it on the uuid change. */
const LIFECYCLE_EXPIRY_POLLS = 30;
/** Actions that keep the SAME session uuid (so they need a standalone marker when no uuid change comes).
 *  restart/start/fork all rotate the uuid → they are labeled ON the change and never emitted standalone. */
const STANDALONE_OK = new Set<string>(["resumed"]);

/** The agent's current runtime session, resolved by the host (path + uuid + runtime). */
export interface SessionLoc {
  path: string;
  sessionId: string;
  runtime: string;
}

interface WriterState extends OpencodeReaderState, HermesReaderState {
  sessions: Record<string, { offset: number }>;
  active?: string;
  /** Monotonic count of session transitions — makes each `session.boundary` id unique so a repeated toggle
   *  (A→B→A→B) never collides on the idempotency key (codex MAJOR fold). */
  transitions?: number;
}

export class ActivityLogWriter {
  private readonly log: ActivityLog;
  private readonly statePath: string;
  private state: WriterState = { sessions: {} };
  private norm: ActivityNormalizer = createClaudeNormalizer();
  private opencode?: OpencodeStorageReader;
  private hermes?: HermesStorageReader;
  private normalizerKey?: string;
  private loaded = false;
  // A Tachyon lifecycle action awaiting a boundary. `ready` is false while the action is still in-flight (set
  // BEFORE the await, armed AFTER) so a poll during the await can't act on it prematurely.
  private pendingLifecycle?: { action: string; ready: boolean; polls: number };

  constructor(
    private readonly dir: string,
    agent: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.log = new ActivityLog(dir, agent);
    this.statePath = path.join(dir, `${agentLogId(agent)}.state.json`); // same collision-proof id as the log file
  }

  get logFile(): string { return this.log.file; }

  /** Record a Tachyon lifecycle action (spawn/restart/resume/fork). Set BEFORE the async action; `ready=false`
   *  until `arm()` confirms the action settled, so a poll DURING the action can't act prematurely. `ready=true`
   *  is used for a fork (buffered + applied after the action already returned).
   *  t-9f2641 MINOR fix — a genuine Tachyon action already in flight (not yet armed) must win the boundary
   *  label over a same-tick "rotation-follow" decision; skip the overwrite rather than clobber it. */
  noteLifecycle(action: string, ready = false): void {
    if (action === "rotation-follow" && this.pendingLifecycle && !this.pendingLifecycle.ready) return;
    this.pendingLifecycle = { action, ready, polls: 0 };
  }

  /** Mark the pending lifecycle action as settled (called after the async action succeeds). */
  arm(): void {
    if (this.pendingLifecycle) this.pendingLifecycle.ready = true;
  }

  /** Drop a pending lifecycle action (the action failed). */
  clearLifecycle(): void {
    this.pendingLifecycle = undefined;
  }

  /** Ingest any new activity for the resolved current session. Returns the number of events appended. */
  poll(cur: SessionLoc | undefined): number {
    this.load();
    if (!cur) {
      // gap — no session / gone / shared-cwd ambiguous; never guess. Age a ready pending so it can't linger
      // across the gap and later mislabel an unrelated change.
      const p = this.pendingLifecycle;
      if (p?.ready && ++p.polls >= LIFECYCLE_EXPIRY_POLLS) this.pendingLifecycle = undefined;
      return 0;
    }
    if (cur.runtime === "opencode") {
      this.ensureOpencodeReader();
      let appended = 0;
      const isNewSession = !this.state.opencode?.sessions[cur.sessionId];
      const lc = this.pendingLifecycle?.ready ? this.pendingLifecycle : undefined;
      if (cur.sessionId !== this.state.active) {
        // Opencode stores turns in shared storage instead of one tailed transcript file, but a session-id
        // rotation has the same UI meaning as Claude/Codex: stitch the per-agent log with a boundary marker.
        const reason = lc ? lc.action : isNewSession ? "new" : "resume";
        if (this.state.active) appended += this.emitBoundary(cur, this.state.active, cur.sessionId, reason);
        else if (lc) appended += this.emitBoundary(cur, "", cur.sessionId, lc.action);
        if (lc) this.pendingLifecycle = undefined;
        this.state.active = cur.sessionId;
      }
      appended += this.opencode!.poll(opencodeStorageRoot(cur), cur.sessionId);
      this.state.active = cur.sessionId;
      this.save();
      return appended;
    }

    if (cur.runtime === "hermes") {
      this.ensureHermesReader();
      let appended = 0;
      const isNewSession = !this.state.hermes?.sessions[cur.sessionId];
      const lc = this.pendingLifecycle?.ready ? this.pendingLifecycle : undefined;
      if (cur.sessionId !== this.state.active) {
        const reason = lc ? lc.action : isNewSession ? "new" : "resume";
        if (this.state.active) appended += this.emitBoundary(cur, this.state.active, cur.sessionId, reason);
        else if (lc) appended += this.emitBoundary(cur, "", cur.sessionId, lc.action);
        if (lc) this.pendingLifecycle = undefined;
        this.state.active = cur.sessionId;
      }
      appended += this.hermes!.poll(cur.path, cur.sessionId);
      this.state.active = cur.sessionId;
      this.save();
      return appended;
    }

    let appended = 0;
    const isNewSession = !this.state.sessions[cur.sessionId];
    const lc = this.pendingLifecycle?.ready ? this.pendingLifecycle : undefined; // only act on a SETTLED action

    if (cur.sessionId !== this.state.active) {
      // Session rotated. A settled lifecycle action LABELS this boundary (Tachyon knows it was a
      // restart/resume/fork); otherwise infer — a seen uuid is a /resume, an unseen one is a /clear or fresh.
      const reason = lc ? lc.action : isNewSession ? "new" : "resume";
      if (this.state.active) appended += this.emitBoundary(cur, this.state.active, cur.sessionId, reason);
      else if (lc) appended += this.emitBoundary(cur, "", cur.sessionId, lc.action); // first session + lifecycle (fork/start)
      if (lc) this.pendingLifecycle = undefined; // consumed by the change
      this.state.active = cur.sessionId;
      this.resetNormalizer(cur);
    } else if (lc) {
      // No uuid change. A resume that kept the same session needs a standalone marker; uuid-rotating actions
      // (restart/start/fork) are only ever labeled ON the change — they just wait (with an expiry backstop).
      lc.polls++;
      if (STANDALONE_OK.has(lc.action) && lc.polls >= LIFECYCLE_GRACE_POLLS) {
        if (this.state.active) appended += this.emitBoundary(cur, this.state.active, cur.sessionId, lc.action);
        this.pendingLifecycle = undefined;
      } else if (lc.polls >= LIFECYCLE_EXPIRY_POLLS) {
        this.pendingLifecycle = undefined; // backstop: never linger forever
      }
    }
    // On process/extension restart the persisted writer state may already point at this same session. In that
    // path no session boundary fires, so rehydrate the normalizer from the current runtime before tailing; the
    // default is Claude and would otherwise consume Codex bytes while emitting zero events.
    this.ensureNormalizer(cur);

    // Offset is kept at a LINE BOUNDARY (endOffset minus the trailing partial), so the incomplete trailing record
    // is simply re-read next poll — restart-safe with no `partial` to persist (codex durability fold).
    if (isNewSession) {
      // First encounter — bounded TAIL capture (never a 180MB blocking backfill). Install the session state +
      // advance the cursor ONLY after the read AND ingest succeed (a throw must not skip records — codex BLOCKER).
      let win;
      try { win = readTailWindow(cur.path, MAX_BACKFILL_RECORDS); } catch { return appended; } // don't install on failure
      appended += this.ingestLines(win.lines, cur); // idempotent (record dedup) → safe to retry on a later throw
      this.state.sessions[cur.sessionId] = { offset: win.endOffset - win.partial.length };
    } else {
      const st = this.state.sessions[cur.sessionId];
      let fwd;
      try { fwd = readForward(cur.path, st.offset, Buffer.alloc(0)); } catch { return appended; } // file gone mid-poll
      appended += this.ingestLines(fwd.lines, cur); // ingest BEFORE advancing — a throw leaves the cursor, retry re-reads
      st.offset = fwd.endOffset - fwd.partial.length; // advance only to the last COMPLETE line boundary
    }
    this.save();
    return appended;
  }

  /** Normalize a batch of complete transcript lines and append each source record's renderable events. */
  private ingestLines(lines: string[], cur: SessionLoc): number {
    let appended = 0;
    for (const line of lines) {
      const events = this.norm.push([line]).filter((e) => e.type !== "raw"); // log only RENDERABLE events (no raw bloat)
      if (events.length === 0) continue;
      const recordId = events[0].recordId;
      appended += this.log.appendRecord(
        events,
        { runtime: cur.runtime, sessionId: cur.sessionId, sourcePath: cur.path, ...(recordId ? { recordId } : {}) },
        this.now(),
        collectBlobs(events),
      );
    }
    return appended;
  }

  /** Append one `session.boundary` with a transition-unique, crash-safe idempotency key. */
  private emitBoundary(cur: SessionLoc, from: string, to: string, reason: string): number {
    const n = (this.state.transitions ?? 0) + 1;
    this.state.transitions = n;
    const ev = {
      type: "session.boundary", runtime: cur.runtime as NormalizedEvent["runtime"], sequence: 0,
      payload: { fromSession: from, toSession: to, reason }, raw: null,
    } as NormalizedEvent;
    const out = this.log.appendRecord([ev], { runtime: cur.runtime, sessionId: to, recordId: `boundary:${from}:${to}:${reason}:${n}` }, this.now());
    this.save(); // persist the counter promptly (a boundary is a render hint; a crash can at worst drop one separator)
    return out;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try { this.state = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as WriterState; } catch { this.state = { sessions: {} }; }
    if (!this.state.sessions) this.state.sessions = {};
    // Resuming: a fresh normalizer (its tool-correlation state didn't survive) — orphan tool_results degrade
    // gracefully; we resume from the stored offset so nothing is re-read.
    this.norm = createNormalizer();
    this.normalizerKey = undefined;
    this.opencode = undefined;
    this.hermes = undefined;
  }

  private save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state), "utf8");
    } catch { /* best-effort; record-level idempotency covers a missed save */ }
  }

  private ensureNormalizer(cur: SessionLoc): void {
    const key = normalizerKey(cur);
    if (this.normalizerKey !== key) this.resetNormalizer(cur);
  }

  private resetNormalizer(cur: SessionLoc): void {
    this.norm = createNormalizer(cur.runtime, cur.path);
    this.normalizerKey = normalizerKey(cur);
  }

  private ensureOpencodeReader(): void {
    this.opencode ??= new OpencodeStorageReader(this.log, this.state, this.now);
  }

  private ensureHermesReader(): void {
    this.hermes ??= new HermesStorageReader(this.log, this.state, this.now);
  }
}

function createNormalizer(runtime = "claude", sourcePath?: string): ActivityNormalizer {
  if (runtime === "claude") return createClaudeNormalizer(sourcePath);
  if (runtime === "codex") return createCodexNormalizer(sourcePath);
  if (runtime === "grok") return createGrokNormalizer(sourcePath);
  // Hermes uses HermesStorageReader (SQLite), not line-tail normalizers.
  return { push: () => [] };
}

function normalizerKey(cur: SessionLoc): string {
  return `${cur.runtime}\0${cur.path}\0${cur.sessionId}`;
}

function opencodeStorageRoot(cur: SessionLoc): string {
  return path.basename(cur.path) === `${cur.sessionId}.jsonl` ? path.dirname(cur.path) : cur.path;
}

/** Image bytes to copy into the log's blob store, keyed by the render-side id (from `raw.source.data`). */
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
