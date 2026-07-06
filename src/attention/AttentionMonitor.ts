import { classifyAttentionTail, type TailClassification } from "./patterns.js";
import { detectCompaction } from "../anchor/compaction.js";
import { runtimeOf } from "../resume/adapters.js";
import type { RateLimitInfo, RateLimitRuntime } from "./patterns.js";

export type AttentionState = "working" | "idle" | "needs-input" | "throttled";

/** spec 306 — how long a pane must stay stably throttled before we proactively notify (most CLIs
 *  auto-retry within seconds; this avoids toasting on every transient blip). */
export const THROTTLE_NOTIFY_DELAY_MS = 45_000;

/** t-d65be2 — a pane frozen this long can't still be legitimately "working" even while its
 *  process keeps burning CPU (a retry loop, a wedged subprocess, ...). The confirmed incident
 *  this guards against sat reported as "working" for 58 minutes after a connection drop, which
 *  also blocked write_input's busy check (working/throttled) from ever releasing on its own. */
export const MAX_WORKING_STALL_MS = 20 * 60_000;
const LINUX_CLK_TCK = 100;
const WORKING_CPU_UTILIZATION_THRESHOLD = 0.15;

export interface AgentAttention {
  state: AttentionState;
  /** epoch ms when the current state began */
  since: number;
  /** epoch ms when the current pane content first appeared */
  contentSince: number;
  /** alias for consumers that reason specifically about output stability */
  outputStableSince: number;
  /** changes whenever pane output changes; suitable for per-output-episode dedupe */
  episodeKey: string;
  /** matched prompt/error line when state === "needs-input" | "throttled" */
  matchedLine?: string;
  /** parsed runtime/scope/reset metadata when state === "throttled" due to a real rate limit */
  rateLimit?: RateLimitInfo;
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
  lastTicksAt: number | null;
  state: AttentionState;
  stateSince: number;
  /** episode key for which a needs-input notification was already emitted */
  notifiedEpisode: number | null;
  /** monotonic id for consumers deduping per output episode */
  episodeKey: string;
  /** spec 216 — true while a compaction banner is currently showing (debounces onCompaction) */
  wasCompacted: boolean;
}

export class AttentionMonitor {
  private snaps = new Map<string, Snapshot>();
  private nextEpisode = 1;

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
        contentSince: snap.contentSince,
        outputStableSince: snap.contentSince,
        episodeKey: snap.episodeKey,
        matchedLine: snap.state === "needs-input" || snap.state === "throttled" ? this.lastMatch.get(agent)?.line : undefined,
        rateLimit: snap.state === "throttled" ? this.rateLimitFor(agent) : undefined,
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
      contentSince: snap.contentSince,
      outputStableSince: snap.contentSince,
      episodeKey: snap.episodeKey,
      matchedLine: snap.state === "needs-input" || snap.state === "throttled" ? this.lastMatch.get(agent)?.line : undefined,
      rateLimit: snap.state === "throttled" ? this.rateLimitFor(agent) : undefined,
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
          lastTicksAt: null,
          state: "working",
          stateSince: now,
          notifiedEpisode: null,
          episodeKey: String(this.nextEpisode++),
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
        snap.episodeKey = String(this.nextEpisode++);
        snap.lastTicks = null;
        snap.lastTicksAt = null;
        this.transition(agent, snap, "working", now);
        continue;
      }

      const stableMs = now - snap.contentSince;

      const match = classifyAttentionTail(content, settings.patterns);
      if (match && stableMs >= PATTERN_STABLE_MS) {
        this.lastMatch.set(agent, match);
        // t-d65be2 — a "stall" (turn-ending connection drop) reuses needs-input rather than a new
        // state: the existing machinery already does exactly what a stall needs — one-shot poke to
        // the parent (pokeParentOnNeedsInput) with the matched line, AND write_input's busy check
        // (working/throttled only) already leaves needs-input unblocked for a rescue.
        const state = match.kind === "error" ? "throttled" : "needs-input";
        this.transition(agent, snap, state, now);
        // spec 306 — sustained-throttle anti-spam: fires once, only after the state has HELD for the
        // delay (not on the initial transition), so a blip that self-resolves within the window never
        // toasts. Runs on every tick the match still holds (transition() above is a no-op once already
        // in this state), gated by the same one-shot-per-episode `notifiedEpisode` field needs-input uses.
        if (state === "throttled" && now - snap.stateSince >= THROTTLE_NOTIFY_DELAY_MS && snap.notifiedEpisode !== snap.contentSince) {
          snap.notifiedEpisode = snap.contentSince;
          const rateLimit = this.rateLimitFor(agent, match);
          this.onChange?.(
            agent,
            {
              state: "throttled",
              since: snap.stateSince,
              contentSince: snap.contentSince,
              outputStableSince: snap.contentSince,
              episodeKey: snap.episodeKey,
              matchedLine: match.line,
              rateLimit,
            },
            true,
          );
        }
        continue;
      }

      if (stableMs >= settings.silenceSec * 1000) {
        const ticks = await this.io.cpuTicks(agent);
        // CPU advancing with a frozen pane = thinking, not waiting — but only up to
        // MAX_WORKING_STALL_MS (t-d65be2); past that, a pane this still is treated as
        // idle regardless of CPU, so it can't stay "working" (and write_input-blocking)
        // forever off a wedged subprocess or retry loop.
        if (
          ticks !== null &&
          snap.lastTicks !== null &&
          snap.lastTicksAt !== null &&
          now > snap.lastTicksAt &&
          stableMs < MAX_WORKING_STALL_MS
        ) {
          const utilization = (ticks - snap.lastTicks) / (((now - snap.lastTicksAt) / 1000) * LINUX_CLK_TCK);
          snap.lastTicks = ticks;
          snap.lastTicksAt = now;
          if (utilization > WORKING_CPU_UTILIZATION_THRESHOLD) {
            this.transition(agent, snap, "working", now);
            continue;
          }
        } else {
          snap.lastTicks = ticks;
          snap.lastTicksAt = ticks === null ? null : now;
        }
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
      {
        state,
        since: now,
        contentSince: snap.contentSince,
        outputStableSince: snap.contentSince,
        episodeKey: snap.episodeKey,
        matchedLine: state === "needs-input" || state === "throttled" ? this.lastMatch.get(agent)?.line : undefined,
        rateLimit: state === "throttled" ? this.rateLimitFor(agent) : undefined,
      },
      notify,
    );
  }

  private rateLimitFor(agent: string, match = this.lastMatch.get(agent)): RateLimitInfo | undefined {
    if (!match?.rateLimit) return undefined;
    const runtime = match.rateLimit.runtime ?? this.runtimeFromCmd(agent);
    return { ...match.rateLimit, ...(runtime ? { runtime } : {}) };
  }

  private runtimeFromCmd(agent: string): RateLimitRuntime | undefined {
    const cmd = this.io.cmdOf?.(agent) ?? "";
    const runtime = cmd ? runtimeOf(cmd) : null;
    return runtime === "claude" || runtime === "codex" ? runtime : undefined;
  }
}
