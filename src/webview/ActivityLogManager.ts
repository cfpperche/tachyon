import * as path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { ActivityLogWriter, type SessionLoc } from "../activity/logWriter.js";
import { isResumable } from "../resume/SessionLedger.js";

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
export class ActivityLogManager {
  private readonly writers = new Map<string, { writer: ActivityLogWriter; loc?: SessionLoc; resolvedAt: number }>();
  private readonly pendingNotes = new Map<string, string>(); // lifecycle actions for writers not created yet (fork)
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly getWorkspaces: () => Workspace[],
    private readonly tickMs = 2000,
    private readonly resolveEveryMs = 3000,
    private readonly onAppended?: (workspaceHash: string, agent: string, count: number) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.writers.clear();
    this.pendingNotes.clear();
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
      const now = Date.now();
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
              entry.loc = loc ? { path: loc.path, sessionId: path.basename(loc.path, ".jsonl"), runtime: loc.runtime } : undefined;
            } catch { entry.loc = undefined; } // gap, never guess
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
