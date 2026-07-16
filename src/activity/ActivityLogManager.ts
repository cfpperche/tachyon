import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { ActivityLogWriter, type SessionLoc } from "./logWriter.js";
import { appendOwnerRow, readSessionOwners, resolveRotationFollow, sessionOwnersFile } from "./sessionOwners.js";
import { isResumable } from "../resume/SessionLedger.js";
import { encodeClaudeCwd } from "../resume/adapters.js";

/** t-9f2641 — a resolved claude transcript that hasn't grown for this long is a candidate for rotation-follow
 *  (a mid-run rotation left it dead while the process kept running). Matches the incident's "no growth for
 *  >=60s" threshold; short of this, a merely-quiet agent must not be mistaken for a dead transcript. */
const ROTATION_DEAD_THRESHOLD_MS = 60_000;

/**
 * spec 239 inc 3b — runs ONE always-on durable-log writer per resumable agent, independent of any Activity
 * panel (codex: unobserved session rotation is the real history loss — a panel-driven writer would miss
 * /clear→/clear sequences). Each tick it ingests new activity into the agent's `.tachyon/activity/<agent>.jsonl`.
 *
 * Perf (spec-221 lesson): the expensive part is `transcriptPathOf`'s project-dir SCAN, so the current session
 * is RE-RESOLVED on a slow cadence and cached; the frequent tick only does the cheap offset-bounded ingest.
 *
 * Known limit (codex): a session switch that occurs AND reverts within one resolve interval (A→B→A in <
 * `resolveEveryMs`) can be missed — the cached location keeps ingesting the old session. Real /clear–/resume
 * flows are seconds+ apart, so this is an accepted boundary, not a correctness hole for normal use.
 */
interface DeadTranscriptTrack {
  path: string;
  lastMtimeMs: number;
  /** wall-clock time the tracked path last showed growth (or was first observed) — the stall clock. */
  sinceMs: number;
}

interface WriterEntry {
  writer: ActivityLogWriter;
  loc?: SessionLoc;
  resolvedAt: number;
  /** t-9f2641 — growth tracking for the currently-resolved transcript, so a mid-run rotation can be detected
   *  without a single stat guessing at "dead" (a session can legitimately go quiet for a while). */
  deadTrack?: DeadTranscriptTrack;
}

export class ActivityLogManager {
  private readonly writers = new Map<string, WriterEntry>();
  private readonly pendingNotes = new Map<string, string>(); // lifecycle actions for writers not created yet (fork)
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private currentTick: Promise<void> | undefined;

  constructor(
    private readonly getWorkspaces: () => Workspace[],
    private readonly tickMs = 2000,
    private readonly resolveEveryMs = 3000,
    private readonly onAppended?: (workspaceHash: string, agent: string, count: number) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.requestTick(), this.tickMs);
    this.requestTick();
  }

  dispose(): void {
    void this.stop();
  }

  /** Stop admitting ticks and await the current filesystem pass before its Workspace is disposed. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.currentTick;
    this.writers.clear();
    this.pendingNotes.clear();
  }

  private requestTick(): void {
    if (this.currentTick) return;
    const tick = this.tick();
    this.currentTick = tick;
    const finish = (): void => {
      if (this.currentTick === tick) this.currentTick = undefined;
    };
    void tick.then(finish, finish);
  }

  /** Record a Tachyon-initiated lifecycle action (call BEFORE the async action) so the agent's log boundary is
   *  labeled from Tachyon's own knowledge, not inferred. Buffered if the writer doesn't exist yet (a fork's
   *  writer is created on the next reconcile — and a buffered note is born READY, since the fork's action has
   *  already returned by the time its writer appears). */
  noteLifecycle(wsHash: string, agent: string, action: string): void {
    const key = `${wsHash}::${agent}`;
    const entry = this.writers.get(key);
    if (entry) entry.writer.noteLifecycle(action); // ready=false — armed after the await
    else this.pendingNotes.set(key, action);
  }

  /** Confirm the lifecycle action settled (call AFTER the await succeeds) so the writer may act on it. */
  armLifecycle(wsHash: string, agent: string): void {
    this.writers.get(`${wsHash}::${agent}`)?.writer.arm();
  }

  /** Drop a pending lifecycle action (the action failed). */
  clearLifecycle(wsHash: string, agent: string): void {
    const key = `${wsHash}::${agent}`;
    this.pendingNotes.delete(key);
    this.writers.get(key)?.writer.clearLifecycle();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // never overlap (a slow resolve must not stack ticks)
    this.ticking = true;
    try {
      const now = this.now();
      const live = new Set<string>();
      for (const ws of this.getWorkspaces()) {
        const dir = path.join(ws.workspaceRoot, ".tachyon", "activity");
        for (const [name, rec] of ws.ledger.all()) {
          if (!isResumable(rec)) continue; // adapter-backed agents only (claude in v1)
          const key = `${ws.wsHash}::${name}`;
          live.add(key);
          let entry = this.writers.get(key);
          if (!entry) {
            entry = { writer: new ActivityLogWriter(dir, name), resolvedAt: 0 };
            this.writers.set(key, entry);
            const note = this.pendingNotes.get(key); // a lifecycle action that arrived before this writer existed (fork)
            if (note) { entry.writer.noteLifecycle(note, true); this.pendingNotes.delete(key); } // born READY — its action already returned
          }

          // Re-resolve the current session on the SLOW cadence (the dir-scan cost); cache it between.
          if (now - entry.resolvedAt >= this.resolveEveryMs) {
            entry.resolvedAt = now;
            try {
              // transcriptPathOf is shared-cwd-safe: it attributes via the captured uuid or the unique title
              // and returns undefined (a gap) in the genuinely-ambiguous id-less case — never another agent's.
              const loc = await ws.manager.transcriptPathOf(name, { live: true });
              entry.loc = loc
                ? {
                    path: loc.path,
                    // Hermes (and any host that already resolved the session id) must not re-derive
                    // from basename — state.db would collapse every session to "state".
                    sessionId: loc.sessionId ?? sessionIdFromTranscriptPath(loc.path, loc.runtime),
                    runtime: loc.runtime,
                  }
                : undefined;
            } catch { entry.loc = undefined; } // gap, never guess

            // t-9f2641 — a harness-driven rotation can mint a new claude transcript with no ownership row
            // (the hook that would have recorded it never fired), so `transcriptPathOf` keeps re-resolving to
            // the SAME dead file forever. Track growth of whatever is currently resolved; once it has stalled
            // past the incident threshold, ask the ownership ledger for an unambiguous newer sibling — never
            // a disk guess — and follow it.
            if (entry.loc && entry.loc.runtime === "claude") {
              entry.deadTrack = updateDeadTrack(entry.deadTrack, entry.loc.path, now);
              if (now - entry.deadTrack.sinceMs >= ROTATION_DEAD_THRESHOLD_MS) {
                const liveDirs = liveClaudeTranscriptDirs(ws.ledger.all(), name);
                const follow = followRotation(ws.workspaceRoot, name, rec.cwd, entry.loc.path, liveDirs, entry.deadTrack.lastMtimeMs);
                if (follow) {
                  entry.loc = { path: follow.transcriptPath, sessionId: follow.sessionId, runtime: entry.loc.runtime };
                  entry.deadTrack = undefined;
                  entry.writer.noteLifecycle("rotation-follow", true); // decided now, not an in-flight Tachyon action
                }
              }
            } else {
              entry.deadTrack = undefined;
            }
          }
          // pin p-4dadd3: a tick snapshots ledger.all() at the top, but the awaits below (transcriptPathOf for
          // any agent) yield — a dismiss that removes the row AND deletes the log can land mid-tick. Re-check
          // the row is STILL present+resumable immediately before poll; a stale writer would otherwise re-append
          // (fresh appendFileSync, no held fd) and resurrect the just-deleted orphan. Drop the writer + skip.
          const cur = ws.ledger.get(name);
          if (!cur || !isResumable(cur)) { this.writers.delete(key); continue; }
          try {
            const appended = entry.writer.poll(entry.loc);
            if (appended > 0) this.onAppended?.(ws.wsHash, name, appended);
          } catch { /* best-effort per agent; one bad agent never stalls the rest */ }
        }
      }
      for (const key of [...this.writers.keys()]) if (!live.has(key)) this.writers.delete(key); // reap gone agents
    } finally {
      this.ticking = false;
    }
  }
}

/** One authoritative human/client start path shared by the legacy shell and persistent engine. */
export interface ActivityLifecycleWorkspace {
  wsHash: string;
  manager: {
    spawn(agent: string): Promise<unknown>;
    restart(agent: string, opts?: { stop?: "graceful" | "force"; session?: "resume" | "new"; gracefulTimeoutMs?: number }): Promise<unknown>;
  };
  lifecycle: { resetBackoff(agent: string): void };
  checkpointBeforeTeardown(agent: string): Promise<void>;
  resumeAgent(agent: string): Promise<void>;
}

export interface ActivityLifecycleRecorder {
  noteLifecycle(workspaceHash: string, agent: string, action: string): void;
  armLifecycle(workspaceHash: string, agent: string): void;
  clearLifecycle(workspaceHash: string, agent: string): void;
}

export async function startAgentWithActivity(
  workspace: ActivityLifecycleWorkspace,
  activityLog: ActivityLifecycleRecorder,
  agent: string,
): Promise<void> {
  await loggedLifecycleAction(activityLog, workspace.wsHash, agent, "started", () => workspace.manager.spawn(agent));
}

/** Preserve the exact manual-restart policy while moving command execution into the persistent engine. */
export async function restartAgentWithActivity(
  workspace: ActivityLifecycleWorkspace,
  activityLog: ActivityLifecycleRecorder,
  agent: string,
  opts?: { stop?: "graceful" | "force"; session?: "resume" | "new"; gracefulTimeoutMs?: number },
): Promise<unknown> {
  workspace.lifecycle.resetBackoff(agent);
  await workspace.checkpointBeforeTeardown(agent);
  return loggedLifecycleAction(activityLog, workspace.wsHash, agent, "restarted", () => workspace.manager.restart(agent, opts));
}

/** Preserve the manual-resume backoff reset and durable Activity boundary on both execution paths. */
export async function resumeAgentWithActivity(
  workspace: ActivityLifecycleWorkspace,
  activityLog: ActivityLifecycleRecorder,
  agent: string,
): Promise<void> {
  workspace.lifecycle.resetBackoff(agent);
  await loggedLifecycleAction(activityLog, workspace.wsHash, agent, "resumed", () => workspace.resumeAgent(agent));
}

async function loggedLifecycleAction(
  activityLog: ActivityLifecycleRecorder,
  workspaceHash: string,
  agent: string,
  action: string,
  run: () => Promise<unknown>,
): Promise<unknown> {
  activityLog.noteLifecycle(workspaceHash, agent, action);
  try {
    const result = await run();
    activityLog.armLifecycle(workspaceHash, agent);
    return result;
  } catch (error) {
    activityLog.clearLifecycle(workspaceHash, agent);
    throw error;
  }
}

/**
 * Session uuid for ActivityLogWriter. Claude/Codex/OpenCode use `<uuid>.jsonl` basenames;
 * Grok uses `…/<uuid>/chat_history.jsonl` — basename alone would be the constant `chat_history`
 * and collapse every session into one writer key (t-9874be).
 * Hermes uses `$HERMES_HOME/state.db` — basename is always `state`; prefer `loc.sessionId` from
 * transcriptPathOf. Fallback keeps a non-empty string for logging only.
 */
export function sessionIdFromTranscriptPath(transcriptPath: string, runtime?: string): string {
  if (runtime === "hermes" || path.basename(transcriptPath) === "state.db") {
    return path.basename(path.dirname(transcriptPath)) || "hermes";
  }
  const base = path.basename(transcriptPath, ".jsonl");
  if (base === "chat_history" || runtime === "grok") {
    return path.basename(path.dirname(transcriptPath));
  }
  return base;
}

/** t-9f2641 — advance (or reset) the stall clock for the currently-resolved transcript. A path change or a
 *  growing mtime restarts the clock; anything else (same path, no growth) leaves `sinceMs` untouched so the
 *  stall duration keeps accumulating across resolve cycles. */
function updateDeadTrack(prev: DeadTranscriptTrack | undefined, filePath: string, now: number): DeadTranscriptTrack {
  let mtime: number | undefined;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { mtime = undefined; }
  if (!prev || prev.path !== filePath) return { path: filePath, lastMtimeMs: mtime ?? now, sinceMs: now };
  if (mtime !== undefined && mtime > prev.lastMtimeMs) return { path: filePath, lastMtimeMs: mtime, sinceMs: now };
  return prev;
}

/** t-9f2641 — the resolved transcript has shown no growth for `ROTATION_DEAD_THRESHOLD_MS`: consult the
 *  ownership ledger for an unambiguous newer sibling (`resolveRotationFollow` never guesses) and, on a hit,
 *  mint a durable "rotation-follow" owner row so the decision is auditable and future resolves (via
 *  Workspace's `ownedSession`, which reads this same file) land on the new session directly.
 *  `liveDirs` and `deadMtimeBaseline` close review gaps found on the first delivery: `liveDirs` is the
 *  TOCTOU fix (a currently-declared sibling's dir counts as ambiguous even before its own owner row exists);
 *  `deadMtimeBaseline` lets the resolver evidence "newer than" even once the dead file itself is pruned. */
function followRotation(
  workspaceRoot: string,
  agent: string,
  cwd: string,
  deadTranscriptPath: string,
  liveDirs: string[],
  deadMtimeBaseline: number,
): { transcriptPath: string; sessionId: string } | undefined {
  const ownersFile = sessionOwnersFile(workspaceRoot);
  const follow = resolveRotationFollow(readSessionOwners(ownersFile), agent, deadTranscriptPath, {
    liveTranscriptDirs: liveDirs,
    deadMtimeBaseline,
  });
  if (!follow) return undefined;
  appendOwnerRow(ownersFile, {
    agent,
    sessionId: follow.sessionId,
    transcriptPath: follow.transcriptPath,
    cwd,
    source: "rotation-follow",
    ts: new Date().toISOString(),
  });
  return follow;
}

/** t-9f2641 MAJOR fix — the transcript directory a live (currently-declared) claude agent's OWN session
 *  would land in, computed the same way claude/Tachyon derive it (`${configHome}/projects/${encodeClaudeCwd(cwd)}`),
 *  defaulting to `~/.claude` when the ledger row has no persisted config home yet. `ws.ledger.all()` is a
 *  synchronous in-memory snapshot — no I/O, race-free within the same tick — so this closes the TOCTOU where
 *  a sibling's brand-new first session appears on disk before its SessionStart hook records its owner row. */
function liveClaudeTranscriptDirs(
  ledgerEntries: Iterable<[string, { resume?: { runtime?: string; configHome?: string }; cwd: string }]>,
  excludeAgent: string,
): string[] {
  const dirs: string[] = [];
  for (const [otherAgent, rec] of ledgerEntries) {
    if (otherAgent === excludeAgent) continue;
    if (rec.resume?.runtime !== "claude") continue;
    const configHome = rec.resume.configHome ?? path.join(os.homedir(), ".claude");
    dirs.push(path.join(configHome, "projects", encodeClaudeCwd(path.resolve(rec.cwd))));
  }
  return dirs;
}
