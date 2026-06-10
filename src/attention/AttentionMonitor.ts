import { classifyTail, type TailMatch } from "./patterns.js";

export type AttentionState = "working" | "idle" | "needs-input";

export interface AgentAttention {
  state: AttentionState;
  /** epoch ms when the current state began */
  since: number;
  /** matched prompt line when state === "needs-input" */
  matchedLine?: string;
}

export interface AttentionSettings {
  enabled: boolean;
  silenceSec: number;
  /** extra per-agent patterns, pre-compiled */
  patterns: RegExp[];
}

/** Injected IO — the monitor itself is pure state-machine and fully unit-testable. */
export interface MonitorIO {
  runningAgents(): Promise<string[]>;
  capturePane(agent: string): Promise<string>;
  /** cumulative CPU ticks of the agent's process subtree; null when unknown (e.g. macOS) */
  cpuTicks(agent: string): Promise<number | null>;
  settingsOf(agent: string): AttentionSettings;
  now(): number;
}

/** Pattern matches only count once the pane has been stable this long (avoids mid-redraw reads). */
export const PATTERN_STABLE_MS = 2500;

interface Snapshot {
  content: string;
  contentSince: number;
  lastTicks: number | null;
  state: AttentionState;
  stateSince: number;
  /** episode key for which a needs-input notification was already emitted */
  notifiedEpisode: number | null;
}

export class AttentionMonitor {
  private snaps = new Map<string, Snapshot>();

  constructor(
    private readonly io: MonitorIO,
    /** fired on every state transition; `notify` is true exactly once per needs-input episode */
    private readonly onChange?: (agent: string, attention: AgentAttention, notify: boolean) => void,
  ) {}

  /** Current state of every tracked agent. */
  states(): Map<string, AgentAttention> {
    const out = new Map<string, AgentAttention>();
    for (const [agent, snap] of this.snaps) {
      out.set(agent, {
        state: snap.state,
        since: snap.stateSince,
        matchedLine: snap.state === "needs-input" ? this.lastMatch.get(agent)?.line : undefined,
      });
    }
    return out;
  }

  stateOf(agent: string): AgentAttention | undefined {
    const snap = this.snaps.get(agent);
    if (!snap) return undefined;
    return {
      state: snap.state,
      since: snap.stateSince,
      matchedLine: snap.state === "needs-input" ? this.lastMatch.get(agent)?.line : undefined,
    };
  }

  needsInputCount(): number {
    let n = 0;
    for (const snap of this.snaps.values()) if (snap.state === "needs-input") n++;
    return n;
  }

  private lastMatch = new Map<string, TailMatch>();

  async tick(): Promise<void> {
    const now = this.io.now();
    const running = await this.io.runningAgents();
    const tracked = running.filter((a) => this.io.settingsOf(a).enabled);

    // Drop agents that stopped or were disabled.
    for (const agent of [...this.snaps.keys()]) {
      if (!tracked.includes(agent)) {
        this.snaps.delete(agent);
        this.lastMatch.delete(agent);
      }
    }

    for (const agent of tracked) {
      const settings = this.io.settingsOf(agent);
      let content: string;
      try {
        content = (await this.io.capturePane(agent)).replace(/\s+$/, "");
      } catch {
        continue; // session vanished between list and capture
      }

      let snap = this.snaps.get(agent);
      if (!snap) {
        snap = {
          content,
          contentSince: now,
          lastTicks: null,
          state: "working",
          stateSince: now,
          notifiedEpisode: null,
        };
        this.snaps.set(agent, snap);
        continue;
      }

      if (content !== snap.content) {
        // Activity: new content resets the episode and returns to working.
        snap.content = content;
        snap.contentSince = now;
        snap.lastTicks = null;
        this.transition(agent, snap, "working", now);
        continue;
      }

      const stableMs = now - snap.contentSince;

      const match = classifyTail(content, settings.patterns);
      if (match && stableMs >= PATTERN_STABLE_MS) {
        this.lastMatch.set(agent, match);
        this.transition(agent, snap, "needs-input", now);
        continue;
      }

      if (stableMs >= settings.silenceSec * 1000) {
        const ticks = await this.io.cpuTicks(agent);
        if (ticks !== null && snap.lastTicks !== null && ticks !== snap.lastTicks) {
          // CPU advancing with a frozen pane = thinking, not waiting.
          snap.lastTicks = ticks;
          this.transition(agent, snap, "working", now);
          continue;
        }
        snap.lastTicks = ticks;
        this.transition(agent, snap, "idle", now);
      }
    }
  }

  private transition(agent: string, snap: Snapshot, state: AttentionState, now: number): void {
    if (snap.state === state) return;
    snap.state = state;
    snap.stateSince = now;
    let notify = false;
    if (state === "needs-input") {
      // One notification per episode; the episode key is when this content appeared.
      if (snap.notifiedEpisode !== snap.contentSince) {
        snap.notifiedEpisode = snap.contentSince;
        notify = true;
      }
    }
    this.onChange?.(
      agent,
      { state, since: now, matchedLine: state === "needs-input" ? this.lastMatch.get(agent)?.line : undefined },
      notify,
    );
  }
}
