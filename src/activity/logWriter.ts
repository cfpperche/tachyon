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
import { ActivityLog } from "./logStore.js";
import { createClaudeNormalizer, type ClaudeNormalizer } from "./claudeNormalizer.js";
import { readForward, readTailWindow } from "./tailReader.js";
import type { NormalizedEvent } from "./types.js";

/** First time a session is seen, capture only its recent tail (not a 180MB-class backfill that would block
 *  activation) — the deep history stays in the runtime file (reachable via "Open transcript"). From then on
 *  everything appended is logged. Consistent with "lineage starts now". */
const MAX_BACKFILL_RECORDS = 4000;

/** The agent's current runtime session, resolved by the host (path + uuid + runtime). */
export interface SessionLoc {
  path: string;
  sessionId: string;
  runtime: string;
}

interface WriterState {
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
  private norm: ClaudeNormalizer = createClaudeNormalizer();
  private loaded = false;

  constructor(
    private readonly dir: string,
    agent: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.log = new ActivityLog(dir, agent);
    this.statePath = path.join(dir, `${sanitize(agent)}.state.json`);
  }

  get logFile(): string { return this.log.file; }

  /** Ingest any new activity for the resolved current session. Returns the number of events appended. */
  poll(cur: SessionLoc | undefined): number {
    this.load();
    if (!cur) return 0; // gap — no session / gone / shared-cwd ambiguous; never guess (prefer-gap-over-misattribution)

    let appended = 0;
    const isNewSession = !this.state.sessions[cur.sessionId];

    if (cur.sessionId !== this.state.active) {
      // session rotated — emit ONE boundary (id unique per transition), continue in the same log, fresh normalizer.
      if (this.state.active) {
        const n = (this.state.transitions ?? 0) + 1;
        this.state.transitions = n;
        appended += this.log.appendRecord(
          [this.boundary(cur.runtime, this.state.active, cur.sessionId)],
          { runtime: cur.runtime, sessionId: cur.sessionId, recordId: `boundary:${this.state.active}:${cur.sessionId}:${n}` },
          this.now(),
        );
        this.save(); // persist the counter promptly so a crash can't reuse it (a boundary is a render hint; the
                     // residual crash-between-append-and-save window can at worst drop one cosmetic separator)
      }
      this.state.active = cur.sessionId;
      this.norm = createClaudeNormalizer(cur.path);
    }

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

  private boundary(runtime: string, from: string, to: string): NormalizedEvent {
    return {
      type: "session.boundary", runtime: runtime as NormalizedEvent["runtime"], sequence: 0,
      payload: { fromSession: from, toSession: to, reason: "switch" }, raw: null,
    } as NormalizedEvent;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try { this.state = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as WriterState; } catch { this.state = { sessions: {} }; }
    if (!this.state.sessions) this.state.sessions = {};
    // Resuming: a fresh normalizer (its tool-correlation state didn't survive) — orphan tool_results degrade
    // gracefully; we resume from the stored offset so nothing is re-read.
    this.norm = createClaudeNormalizer();
  }

  private save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state), "utf8");
    } catch { /* best-effort; record-level idempotency covers a missed save */ }
  }
}

/** Image bytes to copy into the log's blob store, keyed by the render-side id (from `raw.source.data`). */
function collectBlobs(events: NormalizedEvent[]): Map<string, Buffer> | undefined {
  let m: Map<string, Buffer> | undefined;
  for (const ev of events) {
    if (ev.type !== "image.attached") continue;
    const id = (ev.payload as { id?: string }).id;
    const data = (ev.raw as { source?: { data?: string } } | undefined)?.source?.data;
    if (id && typeof data === "string") (m ??= new Map()).set(id, Buffer.from(data, "base64"));
  }
  return m;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
