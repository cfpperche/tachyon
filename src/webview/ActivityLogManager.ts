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
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly getWorkspaces: () => Workspace[],
    private readonly tickMs = 2000,
    private readonly resolveEveryMs = 3000,
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
          if (!entry) { entry = { writer: new ActivityLogWriter(dir, name), resolvedAt: 0 }; this.writers.set(key, entry); }

          // Re-resolve the current session on the SLOW cadence (the dir-scan cost); cache it between.
          if (now - entry.resolvedAt >= this.resolveEveryMs) {
            entry.resolvedAt = now;
            try {
              const loc = await ws.manager.transcriptPathOf(name, { live: true });
              entry.loc = loc ? { path: loc.path, sessionId: path.basename(loc.path, ".jsonl"), runtime: loc.runtime } : undefined;
            } catch { entry.loc = undefined; } // gap, never guess
          }
          try { entry.writer.poll(entry.loc); } catch { /* best-effort per agent; one bad agent never stalls the rest */ }
        }
      }
      for (const key of [...this.writers.keys()]) if (!live.has(key)) this.writers.delete(key); // reap gone agents
    } finally {
      this.ticking = false;
    }
  }
}
