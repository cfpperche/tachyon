import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * spec 241 D9 — per-agent DISCONTINUITY state, persisted SEPARATELY from the sessionId so a same-session
 * post-compaction resume is classified as "needs restore" (the central D3 correctness fix). This is Tachyon-
 * owned bookkeeping (the agent never writes it), distinct from the agent-authored brief (`<agent>.md`).
 *
 *   .tachyon/continuity/<agent>.state.json
 */

export interface ContinuityStateData {
  /** a compaction / `/clear` / session-change / restart happened that the agent hasn't been re-anchored from */
  discontinuitySinceRestore: boolean;
  /** the activity seq at the last discontinuity (diagnostic) */
  lastDiscontinuitySeq?: number;
  /** the activity seq at the last restore injection (diagnostic) */
  lastRestoreSeq?: number;
  /** ISO time of the last pane nudge — drives the cooldown (D5/OQ1) */
  lastNudgeAt?: string;
  /** last observed activity-writer `transitions` counter — a bump means a new session (/clear, restart, external) */
  lastSeenTransitions?: number;
}

const DEFAULT: ContinuityStateData = { discontinuitySinceRestore: false };

export class ContinuityState {
  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "continuity");
  }

  pathOf(agent: string): string {
    return path.join(this.dir, `${agent}.state.json`);
  }

  read(agent: string): ContinuityStateData {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pathOf(agent), "utf8")) as Partial<ContinuityStateData>;
      return { ...DEFAULT, ...parsed, discontinuitySinceRestore: !!parsed.discontinuitySinceRestore };
    } catch {
      return { ...DEFAULT };
    }
  }

  private write(agent: string, data: ContinuityStateData): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.pathOf(agent);
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`; // unique across processes/windows
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
  }

  /** A discontinuity occurred (compaction / clear / session-change / restart) — the agent will need its brief back. */
  markDiscontinuity(agent: string, seq?: number): void {
    const s = this.read(agent);
    this.write(agent, { ...s, discontinuitySinceRestore: true, lastDiscontinuitySeq: seq ?? s.lastDiscontinuitySeq });
  }

  /** We re-injected the continuity pointer (restore served) — clear the flag. */
  markRestored(agent: string, seq?: number): void {
    const s = this.read(agent);
    this.write(agent, { ...s, discontinuitySinceRestore: false, lastRestoreSeq: seq ?? s.lastRestoreSeq });
  }

  /** Record a pane nudge time for the cooldown (D5/OQ1). */
  markNudged(agent: string, atIso: string): void {
    this.write(agent, { ...this.read(agent), lastNudgeAt: atIso });
  }

  /** Remember the activity-writer transition counter we've already accounted for (session-change detection). */
  setLastSeenTransitions(agent: string, transitions: number): void {
    this.write(agent, { ...this.read(agent), lastSeenTransitions: transitions });
  }

  /** Remove an agent's state (delete/dismiss). */
  remove(agent: string): void {
    try {
      fs.rmSync(this.pathOf(agent), { force: true });
    } catch {
      /* best-effort */
    }
  }
}
