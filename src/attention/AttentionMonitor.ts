import { classifyAttentionTail, type TailClassification } from "./patterns.js";
import { detectCompaction } from "../anchor/compaction.js";

export type AttentionState = "working" | "idle" | "needs-input" | "throttled";

/** spec 306 — how long a pane must stay stably throttled before we proactively notify (most CLIs
 *  auto-retry within seconds; this avoids toasting on every transient blip). */
export const THROTTLE_NOTIFY_DELAY_MS = 45_000;

export interface AgentAttention {
  state: AttentionState;
  /** epoch ms when the current state began */
  since: number;
  /** matched prompt/error line when state === "needs-input" | "throttled" */
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
  /** spec 216 — the agent's launch command, for runtime-aware compaction detection; null = unknown */
  cmdOf?(agent: string): string | null;
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
  /** spec 216 — true while a compaction banner is currently showing (debounces onCompaction) */
  wasCompacted: boolean;
}

export class AttentionMonitor {
  private snaps = new Map<string, Snapshot>();

  constructor(
    private readonly io: MonitorIO,
    /** fired on every state transition; `notify` is true exactly once per needs-input episode */
    private readonly onChange?: (agent: string, attention: AgentAttention, notify: boolean) => void,
    /** spec 216 — fired once when a compaction banner first appears in an agent's pane */
    private readonly onCompaction?: (agent: string) => void,
  ) {}

  /** Current state of every tracked agent. */
  states(): Map<string, AgentAttention> {
    const out = new Map<string, AgentAttention>();
    for (const [agent, snap] of this.snaps) {
      out.set(agent, {
        state: snap.state,
        since: snap.stateSince,
        matchedLine: snap.state === "needs-input" || snap.state === "throttled" ? this.lastMatch.get(agent)?.line : undefined,
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
      matchedLine: snap.state === "needs-input" || snap.state === "throttled" ? this.lastMatch.get(agent)?.line : undefined,
    };
  }

  needsInputCount(): number {
    let n = 0;
    for (const snap of this.snaps.values()) if (snap.state === "needs-input") n++;
    return n;
  }

  private lastMatch = new Map<string, TailClassification>();

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
          wasCompacted: false,
        };
        this.snaps.set(agent, snap);
        continue;
      }

      // spec 216 — compaction detection rides this capture (no extra tmux read). Fire once when
      // the banner first appears; reset when it clears, so a later compaction fires again.
      const cmd = this.io.cmdOf?.(agent) ?? "";
      const compacted = cmd ? detectCompaction(cmd, content) : false;
      if (compacted && !snap.wasCompacted) {
        snap.wasCompacted = true;
        this.onCompaction?.(agent);
      } else if (!compacted) {
        snap.wasCompacted = false;
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

      const match = classifyAttentionTail(content, settings.patterns);
      if (match && stableMs >= PATTERN_STABLE_MS) {
        this.lastMatch.set(agent, match);
        const state = match.kind === "error" ? "throttled" : "needs-input";
        this.transition(agent, snap, state, now);
        // spec 306 — sustained-throttle anti-spam: fires once, only after the state has HELD for the
        // delay (not on the initial transition), so a blip that self-resolves within the window never
        // toasts. Runs on every tick the match still holds (transition() above is a no-op once already
        // in this state), gated by the same one-shot-per-episode `notifiedEpisode` field needs-input uses.
        if (state === "throttled" && now - snap.stateSince >= THROTTLE_NOTIFY_DELAY_MS && snap.notifiedEpisode !== snap.contentSince) {
          snap.notifiedEpisode = snap.contentSince;
          this.onChange?.(agent, { state: "throttled", since: snap.stateSince, matchedLine: match.line }, true);
        }
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
      { state, since: now, matchedLine: state === "needs-input" || state === "throttled" ? this.lastMatch.get(agent)?.line : undefined },
      notify,
    );
  }
}
