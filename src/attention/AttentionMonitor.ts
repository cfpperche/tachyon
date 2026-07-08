import { classifyAttentionTail, type TailClassification } from "./patterns.js";
import { detectCompaction } from "../anchor/compaction.js";
import { runtimeOf } from "../resume/adapters.js";
import { runtimeProfile, type ComposerRegionProfile } from "../runtime/runtimeProfile.js";
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

/** t-47bfe8 (symphony borrows #2) — a genuinely stuck agent: process alive but producing NO
 *  output for this long. Measured from the LAST output event (contentSince), NOT from pane start
 *  (t-dbacb8 study): a slow-but-progressing agent keeps moving content and resets the clock, so
 *  it never trips this — only continuous inactivity does. Crucial distinction from a wall-clock
 *  timeout, which would false-positive on GLM's silent "think" episodes (the flicker measured in
 *  t-6a5dae): those still belong to a working turn and would be killed wrongly by a flat
 *  deadline. Pairs with MAX_WORKING_STALL_MS — the heartbeat cap (20min) tells a CPU-busy
 *  frozen pane "you're stuck" first; this fires once the stuck agent has been idle the full
 *  window with no output at all, the signal a future "unresponsive → flag/kill" consumer keys on. */
export const STALL_AFTER_MS = 5 * 60_000;
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
  /** t-47bfe8 — true once the agent has been continuously inactive (no output) past
   *  STALL_AFTER_MS; cleared the moment new output appears. The state stays "idle" — this is
   *  an independent latched flag, not a new AttentionState, so existing webview/sidebar rendering
   *  (which switches on state) is untouched. Consumers reading `stalled` are the future flag/kill
   *  surface; nothing in the today-tree branches on it yet. */
  stalled: boolean;
  /** t-35d95a — an AUTHORED (never derived) "this agent needs a human" latch, set via
   *  flagAwaitingHuman (the request_human_attention Bridge tool's target). Independent flag, not a
   *  new AttentionState. Cleared only when a new turn starts: the next idle -> working edge after the
   *  latch was set, which is the monitor boundary that represents the human having responded. */
  awaitingHuman: boolean;
  /** the one-line reason passed to flagAwaitingHuman; present only while awaitingHuman is true. */
  awaitingHumanReason?: string;
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

/** t-64f501 (review follow-up) — a matched line only wins content-change precedence while it sits
 *  within this many non-empty tail lines of the bottom. Prompts live at the bottom (patterns.ts's
 *  own TAIL_WINDOW comment), but a real modal can have a couple of option/hint lines rendered
 *  below the question itself before the terminal's true last line — e.g. Claude Code's permission
 *  dialog ("Do you want to...?" followed by "❯ 1. Yes" / "2. Yes, and don't ask again" / "3. No…")
 *  puts the matched question 3 lines above the bottom. 3 covers that shape (and the opencode
 *  JSON runtime-error fixture, whose message line sits 3 lines above its closing braces) without
 *  being loose enough to let a prompt-shaped line several lines up in ordinary, still-progressing
 *  output (a test runner echoing a fixture string) win precedence just because it hasn't scrolled
 *  out of the 8-line TAIL_WINDOW yet. */
export const PATTERN_POSITION_TOLERANCE = 3;

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
  /** t-47bfe8 — latched true once inactivity crossed STALL_AFTER_MS; cleared on new output */
  stalled: boolean;
  /** t-47bfe8 — one-shot guard so onStalled fires exactly once per idle episode */
  stallNotified: boolean;
  /** t-35d95a — latched true once flagAwaitingHuman has been called; cleared on the next new-turn edge */
  awaitingHuman: boolean;
  /** t-35d95a — the reason passed to flagAwaitingHuman; cleared alongside awaitingHuman */
  awaitingHumanReason: string | undefined;
  /** t-35d95a — one-shot guard so the toast fires exactly once per awaiting-human episode */
  awaitingHumanNotified: boolean;
  /** t-64f501 — epoch ms since the CURRENT matched pattern has been continuously recognized (near
   *  the bottom of) the tail, independent of contentSince: unrelated pane churn (e.g. a parallel
   *  tool still streaming output) must not reset this, or a genuine modal prompt would never
   *  accumulate enough stability to win. null while no (position-gated) pattern is present. */
  matchSince: number | null;
  /** t-64f501 (review follow-up) — keyed on the matched PATTERN SOURCE (classifyAttentionTail's
   *  `pattern`), not the matched line text. A live-updating substring in an otherwise-identical
   *  prompt line (a rate-limit countdown ticking "45s" -> "44s" -> ...) must not reset this every
   *  tick — stability means "the same kind of prompt is still showing", not "the exact same bytes
   *  are still showing". A different pattern (or the pattern disappearing, or the match falling
   *  outside PATTERN_POSITION_TOLERANCE of the bottom) starts a fresh stability window. */
  matchKey: string | null;
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
    /** t-47bfe8 — fired ONCE per idle episode when continuous inactivity (no output) crosses
     *  STALL_AFTER_MS. Mirrors onCompaction's one-shot shape; the visible flag lives on
     *  AgentAttention.stalled, which stays true until the agent emits new output. */
    private readonly onStalled?: (agent: string) => void,
  ) {}

  /** Current state of every tracked agent. */
  states(): Map<string, AgentAttention> {
    const out = new Map<string, AgentAttention>();
    for (const [agent, snap] of this.snaps) out.set(agent, this.toAttention(agent, snap));
    return out;
  }

  stateOf(agent: string): AgentAttention | undefined {
    const snap = this.snaps.get(agent);
    if (!snap) return undefined;
    return this.toAttention(agent, snap);
  }

  private toAttention(agent: string, snap: Snapshot): AgentAttention {
    return {
      state: snap.state,
      since: snap.stateSince,
      contentSince: snap.contentSince,
      outputStableSince: snap.contentSince,
      episodeKey: snap.episodeKey,
      matchedLine: snap.state === "needs-input" || snap.state === "throttled" ? this.lastMatch.get(agent)?.line : undefined,
      rateLimit: snap.state === "throttled" ? this.rateLimitFor(agent) : undefined,
      stalled: snap.stalled,
      awaitingHuman: snap.awaitingHuman,
      awaitingHumanReason: snap.awaitingHumanReason,
    };
  }

  /** t-47bfe8 — true once continuous inactivity has crossed STALL_AFTER_MS, cleared on new output. */
  isStalled(agent: string): boolean {
    return this.snaps.get(agent)?.stalled ?? false;
  }

  /** t-47bfe8 — agents currently latched into the stalled flag (genuinely stuck: idle past the
   *  full inactivity window with no output). For the future "unresponsive → flag/kill" consumer. */
  stalledAgents(): Set<string> {
    const out = new Set<string>();
    for (const [agent, snap] of this.snaps) if (snap.stalled) out.add(agent);
    return out;
  }

  /** t-35d95a — true once flagAwaitingHuman has latched this agent, cleared on the next new-turn edge. */
  isAwaitingHuman(agent: string): boolean {
    return this.snaps.get(agent)?.awaitingHuman ?? false;
  }

  /** t-35d95a — agents currently latched awaiting a human (request_human_attention was called and
   *  the human has not answered with a new turn yet). For the sidebar badge. */
  awaitingHumanAgents(): Set<string> {
    const out = new Set<string>();
    for (const [agent, snap] of this.snaps) if (snap.awaitingHuman) out.add(agent);
    return out;
  }

  /** t-35d95a — external, agent-authored "I need a human" signal for the LIVE conversation attention
   *  substrate (distinct from Task.flag_for_human, which flags a Task on the board, not a live pane).
   *  Mirrors the `stalled` latch exactly: an independent flag on AgentAttention, NOT a new
   *  AttentionState — the existing working/idle/needs-input/throttled state machine is untouched.
   *  Called from the request_human_attention Bridge tool via the Workspace wiring. Cleared
   *  automatically on the next idle -> working edge after the latch was set: same-turn pane output is
   *  still the agent talking, not the human having responded. Fires onChange once (notify=true),
   *  reusing the same callback the needs-input toast/badge already rides, so Workspace can toast +
   *  the sidebar VM can read the latch without a second callback param. No-op if the
   *  agent isn't currently tracked (has never ticked). OS/mobile push is OUT OF SCOPE here — deferred
   *  to the companion (t-fe52f0/t-619157); this wiring is in-app badge+toast only. */
  flagAwaitingHuman(agent: string, reason: string): void {
    const snap = this.snaps.get(agent);
    if (!snap) return;
    snap.awaitingHuman = true;
    snap.awaitingHumanReason = reason;
    const notify = !snap.awaitingHumanNotified;
    snap.awaitingHumanNotified = true;
    this.onChange?.(agent, this.toAttention(agent, snap), notify);
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
        const initialMatch = this.classifyForPrecedence(content, settings.patterns);
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
          stalled: false,
          stallNotified: false,
          awaitingHuman: false,
          awaitingHumanReason: undefined,
          awaitingHumanNotified: false,
          matchSince: initialMatch ? now : null,
          matchKey: initialMatch ? initialMatch.pattern : null,
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

      const contentChanged = content !== snap.content;
      if (contentChanged && this.isComposerOnlyChange(agent, snap.content, content)) {
        // Composer typing isn't agent output — the agent itself didn't emit, so idle/stall
        // accounting carries over (a stuck agent stays stuck even while a human drafts input).
        this.evaluateStall(agent, snap, now);
        continue;
      }

      if (contentChanged) {
        // Activity: new content resets the episode's idle/stall clocks. This runs regardless of
        // the pattern precedence below — a concurrent tool still streaming output legitimately
        // resets staleness accounting even while a modal prompt sits in the same pane.
        snap.content = content;
        snap.contentSince = now;
        snap.episodeKey = String(this.nextEpisode++);
        snap.lastTicks = null;
        snap.lastTicksAt = null;
        snap.stalled = false;
        snap.stallNotified = false;
      }

      // t-64f501 — needs-input/error precedence: a recognized pattern in the CURRENT pane
      // snapshot wins over content-change/working classification. A modal permission prompt
      // doesn't stop blocking just because some other line of the pane (a parallel tool still
      // streaming output in the same turn) kept changing. Stability is tracked against the
      // matched PATTERN (matchSince/matchKey, keyed on match.pattern — see Snapshot's doc-comment
      // for why not the matched line's text) rather than contentSince, precisely so that unrelated
      // churn elsewhere in the pane can't hold a genuine prompt below the debounce threshold
      // forever — the failure mode this fixes. classifyForPrecedence additionally requires the
      // match to sit near the bottom of the tail (PATTERN_POSITION_TOLERANCE), so prompt-shaped
      // text that's merely part of ordinary, still-progressing output further up the tail can't
      // win this precedence just because it hasn't scrolled out of the tail window yet.
      const match = this.classifyForPrecedence(content, settings.patterns);
      if (match) {
        if (snap.matchKey !== match.pattern) {
          snap.matchSince = now;
          snap.matchKey = match.pattern;
        }
        const matchStableMs = now - (snap.matchSince ?? now);
        if (matchStableMs >= PATTERN_STABLE_MS) {
          this.lastMatch.set(agent, match);
          // t-d65be2 — a "stall" (turn-ending connection drop) reuses needs-input rather than a new
          // state: the existing machinery already does exactly what a stall needs — one-shot poke to
          // the parent (pokeParentOnNeedsInput) with the matched line, AND write_input's busy check
          // (working/throttled only) already leaves needs-input unblocked for a rescue.
          const state = match.kind === "error" ? "throttled" : "needs-input";
          // New output (in t-d65be2 sense — pane changed to a recognized prompt/error line) clears
          // the inactivity stall flag: the agent isn't silently stuck anymore, it's interacting.
          snap.stalled = false;
          snap.stallNotified = false;
          this.transition(agent, snap, state, now);
          // spec 306 — sustained-throttle anti-spam: fires once, only after the state has HELD for the
          // delay (not on the initial transition), so a blip that self-resolves within the window never
          // toasts. Runs on every tick the match still holds (transition() above is a no-op once already
          // in this state). Gated on snap.matchSince (this throttled episode's start), NOT contentSince
          // (review follow-up) — contentSince is bumped on every tick with ANY pane churn, including
          // unrelated concurrent streaming while the throttle itself holds steady, so keying the one-shot
          // on it re-fired on every churn tick instead of once per episode. matchSince only moves when
          // the matched pattern itself changes or drops, which is exactly "a new throttled episode".
          if (state === "throttled" && now - snap.stateSince >= THROTTLE_NOTIFY_DELAY_MS && snap.notifiedEpisode !== snap.matchSince) {
            snap.notifiedEpisode = snap.matchSince;
            this.onChange?.(agent, this.toAttention(agent, snap), true);
          }
          continue;
        }
        // Pattern present but not yet past the debounce window (avoids mid-redraw flicker
        // misfires): hold the current state rather than letting a concurrent content change
        // flip it to "working" — it either resolves to needs-input/throttled above once stable,
        // or the pattern disappears (else branch below) and normal classification resumes.
        continue;
      }
      snap.matchSince = null;
      snap.matchKey = null;

      if (contentChanged) {
        this.transition(agent, snap, "working", now);
        continue;
      }

      const stableMs = now - snap.contentSince;

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
        // t-47bfe8 — once idle, evaluate the continuous-inactivity stall window. stableMs grew past
        // silenceSec just now; if it ALSO already grew past STALL_AFTER_MS (e.g. the heartbeat cap
        // just decayed a long-frozen-but-CPU-busy pane from working → idle), this fires on the same
        // tick — which is correct: that agent was already stuck, the cap was just the faster signal.
        this.evaluateStall(agent, snap, now);
      }
    }
  }

  /** t-64f501 (review follow-up) — classifyAttentionTail's raw match, additionally gated to
   *  require the matched line sit within PATTERN_POSITION_TOLERANCE of the bottom of the tail.
   *  Used everywhere a match is allowed to WIN precedence over content-change/working
   *  classification; classifyAttentionTail itself stays ungated (existing direct callers/tests
   *  of it are untouched). */
  private classifyForPrecedence(content: string, patterns: RegExp[]): TailClassification | null {
    const match = classifyAttentionTail(content, patterns);
    return match && match.distanceFromBottom <= PATTERN_POSITION_TOLERANCE ? match : null;
  }

  private transition(agent: string, snap: Snapshot, state: AttentionState, now: number): void {
    if (snap.state === state) return;
    const isNewTurnEdge = snap.state !== "working" && state === "working";
    snap.state = state;
    snap.stateSince = now;
    if (isNewTurnEdge && snap.awaitingHuman) {
      snap.awaitingHuman = false;
      snap.awaitingHumanReason = undefined;
      snap.awaitingHumanNotified = false;
    }
    let notify = false;
    if (state === "needs-input") {
      // One notification per episode; the episode key is when this content appeared. Unlike the
      // throttled anti-spam gate below transition()'s call site, this one-shot is NOT vulnerable
      // to the same "contentSince churns every tick" issue (review follow-up): transition() only
      // reaches this branch on an actual state CHANGE (the early return above no-ops once already
      // needs-input), so unrelated concurrent pane churn while already needs-input never re-enters
      // here at all — there's nothing to re-key off contentSince for.
      if (snap.notifiedEpisode !== snap.contentSince) {
        snap.notifiedEpisode = snap.contentSince;
        notify = true;
      }
    }
    this.onChange?.(agent, this.toAttention(agent, snap), notify);
  }

  /** t-47bfe8 — fire onStalled once when continuous inactivity (no output since contentSince)
   *  crosses STALL_AFTER_MS. The visible latch lives on AgentAttention.stalled; this is the
   *  one-shot emit that a future "unresponsive → flag/kill" consumer subscribes to. No-op when
   *  state isn't idle (a needs-input/throttled/working agent can't be stalled by definition) or
   *  when this episode already fired. */
  private evaluateStall(agent: string, snap: Snapshot, now: number): void {
    if (snap.state !== "idle") return;
    if (snap.stallNotified) return;
    if (now - snap.contentSince < STALL_AFTER_MS) return;
    snap.stalled = true;
    snap.stallNotified = true;
    this.onStalled?.(agent);
  }

  private rateLimitFor(agent: string, match = this.lastMatch.get(agent)): RateLimitInfo | undefined {
    if (!match?.rateLimit) return undefined;
    const runtime = match.rateLimit.runtime ?? this.runtimeFromCmd(agent);
    return { ...match.rateLimit, ...(runtime ? { runtime } : {}) };
  }

  private runtimeFromCmd(agent: string): RateLimitRuntime | undefined {
    const cmd = this.io.cmdOf?.(agent) ?? "";
    const runtime = cmd ? runtimeOf(cmd) : null;
    return runtime === "claude" || runtime === "codex" || runtime === "opencode" ? runtime : undefined;
  }

  private isComposerOnlyChange(agent: string, previous: string, next: string): boolean {
    const cmd = this.io.cmdOf?.(agent) ?? "";
    const runtime = cmd ? runtimeOf(cmd) : null;
    const composer = runtime ? runtimeProfile(runtime)?.composer : undefined;
    return composer ? isChangeConfinedToComposer(previous, next, composer) : false;
  }
}

function isChangeConfinedToComposer(previous: string, next: string, composer: ComposerRegionProfile): boolean {
  const previousLines = previous.split("\n");
  const nextLines = next.split("\n");
  const previousStart = findComposerStart(previousLines, composer);
  const nextStart = findComposerStart(nextLines, composer);
  if (previousStart === null || nextStart === null) return false;

  return linesEqual(previousLines.slice(0, previousStart), nextLines.slice(0, nextStart));
}

function findComposerStart(lines: string[], composer: ComposerRegionProfile): number | null {
  const first = Math.max(0, lines.length - composer.tailLines);
  for (let i = lines.length - 1; i >= first; i--) {
    if (composer.promptLine.test(lines[i])) return i;
  }
  return null;
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, i) => line === b[i]);
}
