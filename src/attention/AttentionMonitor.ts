import { classifyAttentionTail, type TailClassification } from "./patterns.js";
import { detectCompaction } from "../anchor/compaction.js";
import { runtimeOf } from "../resume/adapters.js";
import { runtimeProfile } from "../runtime/runtimeProfile.js";
import { composerText, findComposerRegion, isChangeConfinedToComposer, isComposerOccupied, stripAnsi } from "../runtime/composerRegion.js";
import { AUTH_SIGNAL_TAIL_LINES, classifyAuthRequired, type AuthRequiredEvidence } from "../runtime/authRequired.js";
import type { RateLimitInfo, RateLimitRuntime } from "./patterns.js";
import type { ResumeRuntime } from "../resume/adapters.js";

export type AttentionState = "working" | "idle" | "needs-input" | "throttled";

/** spec 306 — how long a pane must stay stably throttled before we proactively notify (most CLIs
 *  auto-retry within seconds; this avoids toasting on every transient blip). */
export const THROTTLE_NOTIFY_DELAY_MS = 45_000;

/** t-d65be2 — a pane frozen this long can't still be legitimately "working" even while its
 *  process keeps burning CPU (a retry loop, a wedged subprocess, ...). The confirmed incident
 *  this guards against sat reported as "working" for 58 minutes after a connection drop, which
 *  also blocked write_input's busy check (working/throttled) from ever releasing on its own. */
export const MAX_WORKING_STALL_MS = 20 * 60_000;
/** t-4b01ce — monitoring is best-effort and must never hold the host heartbeat indefinitely. */
export const ATTENTION_TICK_DEADLINE_MS = 10_000;

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
  /** Positive evidence that this incarnation has actually started a turn. False/undefined keeps a
   * synthetic initial `working` snapshot from being mistaken for busy. */
  hasStartedTurn?: boolean;
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
  /**
   * SDD 477 / `t-5bfb72` — the agent has gone idle because its runtime says it is not authenticated,
   * not because it finished. Another independent latch (never a new AttentionState), carrying the
   * measured evidence so every consumer can name the runtime and the human action without
   * re-deriving them. Undefined means "not latched", which is also what every runtime without a
   * measured profile can ever produce.
   */
  authRequired?: AuthRequiredEvidence;
  /**
   * t-a39c7d — herdr-style done(unseen): agent finished a turn (idle, or completion-hinted idle)
   * and the human has not focused the pane yet. Orthogonal to AttentionState (state stays idle).
   * Cleared by markSeen (sidebar/terminal open) or a new working turn — not by mere output churn
   * in the same idle episode.
   */
  unseen: boolean;
  /** true when the runtime-profiled composer has a non-empty human draft. */
  composerOccupied: boolean;
  /** The last monitor tick missed its deadline or was skipped behind a still-running tick. */
  stale: boolean;
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
  /** Bounded escaped tail capture for runtime composer checks that need ANSI style metadata. */
  capturePaneEscaped?(agent: string, lines: number): Promise<string>;
  /** cumulative CPU ticks of the agent's process subtree; null when unknown (e.g. macOS) */
  cpuTicks(agent: string): Promise<number | null>;
  settingsOf(agent: string): AttentionSettings;
  /**
   * t-8168a7 review — durable/current-incarnation evidence used only for a new snapshot.
   * true = a real turn is proven; false = this host observed the fresh spawn before any turn;
   * undefined = a surviving session whose history cannot be established honestly.
   */
  initialTurnState?(agent: string): boolean | undefined;
  /** spec 216 — the agent's launch command, for runtime-aware compaction detection; null = unknown */
  cmdOf?(agent: string): string | null;
  /** t-10771a — true only for declared top-level agents eligible for derived human-question latches. */
  awaitingHumanOnIdle?(agent: string): boolean;
  /**
   * t-4ecf9a — tmux `#{window_activity}` for the agent's session (unix seconds).
   * `null` = activity feed unavailable (engine down / session not in map) → capture every tick
   * (today's polling fallback). When a finite value is returned, the monitor captures only on
   * activity change or when a silence-threshold recheck is due.
   */
  windowActivity?(agent: string): number | null;
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
const PROSE_QUESTION_TAIL_LINES = 4;
const PROSE_QUESTION_MAX_CHARS = 240;

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
  /** t-5bfb72 — latched measured auth-required evidence; cleared on the next new-turn edge */
  authRequired: AuthRequiredEvidence | undefined;
  /** t-5bfb72 — one-shot guard so the auth-required attention fires exactly once per episode */
  authRequiredNotified: boolean;
  /** t-5bfb72 — epoch ms since the CURRENT auth signal has been continuously visible in the tail;
   *  null while none is. Debounced exactly like a prompt match, for the same reason: a pane read
   *  mid-redraw is not evidence that a human must go and log in. */
  authSince: number | null;
  /** t-5bfb72 — the matched line the current authSince window belongs to */
  authKey: string | null;
  /** t-a39c7d — finished turn not yet viewed by human (done = idle + unseen). */
  unseen: boolean;
  /**
   * t-8168a7 — latched once this pane produces non-composer output after its first observation,
   * or already carries a measured in-flight activity signal on that observation. Unlike launch
   * readiness, true answers that a turn actually ran; undefined preserves unknown reload history.
   */
  hasStartedTurn: boolean | undefined;
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
  /** t-4ecf9a — last #{window_activity} sampled when the activity feed was live; null in poll mode */
  lastWindowActivity: number | null;
  /** t-4ecf9a — epoch ms of the last successful capturePane (gates silence-threshold recheck) */
  lastCaptureAt: number;
  /** t-f45313 — profile-backed guard for a human-owned composer draft. */
  composerOccupied: boolean;
  /** t-dd130a — one human warning per continuously occupied composer episode. */
  composerDraftNotified: boolean;
  /** Whether the composer draft decision had the runtime's measured ANSI evidence available. */
  composerEvidence: boolean;
}

export class AttentionMonitor {
  private snaps = new Map<string, Snapshot>();
  private nextEpisode = 1;
  private tickRunning: Promise<void> | undefined;
  private stale = false;

  constructor(
    private readonly io: MonitorIO,
    /** fired on every state transition; `notify` is true exactly once per actionable episode */
    private readonly onChange?: (
      agent: string,
      attention: AgentAttention,
      notify: boolean,
      cause?: "composer-draft",
    ) => void,
    /** spec 216 — fired once when a compaction banner first appears in an agent's pane */
    private readonly onCompaction?: (agent: string) => void,
    /** t-47bfe8 — fired ONCE per idle episode when continuous inactivity (no output) crosses
     *  STALL_AFTER_MS. Mirrors onCompaction's one-shot shape; the visible flag lives on
     *  AgentAttention.stalled, which stays true until the agent emits new output. */
    private readonly onStalled?: (agent: string) => void,
    private readonly tickDeadlineMs = ATTENTION_TICK_DEADLINE_MS,
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

  /** Native lifecycle edge from the current authenticated runtime process. Pane/CPU polling remains
   * the watchdog and fallback; this only removes its silence delay from a runtime-asserted stop. */
  publishRuntimeStatus(agent: string, event: "stopped"): boolean {
    const snap = this.snaps.get(agent);
    if (!snap || event !== "stopped") return false;
    snap.stalled = false;
    snap.stallNotified = false;
    this.transition(agent, snap, "idle", this.io.now());
    return true;
  }

  private toAttention(agent: string, snap: Snapshot): AgentAttention {
    return {
      state: snap.state,
      hasStartedTurn: snap.hasStartedTurn,
      since: snap.stateSince,
      contentSince: snap.contentSince,
      outputStableSince: snap.contentSince,
      episodeKey: snap.episodeKey,
      matchedLine: snap.state === "needs-input" || snap.state === "throttled" ? this.lastMatch.get(agent)?.line : undefined,
      rateLimit: snap.state === "throttled" ? this.rateLimitFor(agent) : undefined,
      stalled: snap.stalled,
      awaitingHuman: snap.awaitingHuman,
      awaitingHumanReason: snap.awaitingHumanReason,
      authRequired: snap.authRequired,
      unseen: snap.unseen,
      composerOccupied: snap.composerOccupied,
      stale: this.stale,
    };
  }

  /** t-47bfe8 — true once continuous inactivity has crossed STALL_AFTER_MS, cleared on new output. */
  isStalled(agent: string): boolean {
    return this.snaps.get(agent)?.stalled ?? false;
  }

  /** t-8168a7 — whether this tracked agent has produced evidence of a real turn. */
  hasStartedTurn(agent: string): boolean | undefined {
    return this.snaps.get(agent)?.hasStartedTurn;
  }

  /** A lifecycle boundary makes every pane-derived latch belong to the old incarnation. */
  reset(agent: string): void {
    this.snaps.delete(agent);
    this.lastMatch.delete(agent);
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

  /**
   * t-5bfb72 — the measured evidence that this agent cannot execute until a human logs its runtime
   * back in, or undefined. This is the read every HOLD consults: while it answers, no automatic
   * restart and no automatic retry may run against the agent, because both would burn a task queue
   * against a wall a human has to remove.
   */
  authRequiredOf(agent: string): AuthRequiredEvidence | undefined {
    return this.snaps.get(agent)?.authRequired;
  }

  isAuthRequired(agent: string): boolean {
    return this.snaps.get(agent)?.authRequired !== undefined;
  }

  /** t-5bfb72 — agents currently held for authentication. */
  authRequiredAgents(): Set<string> {
    const out = new Set<string>();
    for (const [agent, snap] of this.snaps) if (snap.authRequired) out.add(agent);
    return out;
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
   *  reusing the same callback the needs-input Attention/badge already rides, so Workspace can publish +
   *  the sidebar VM can read the latch without a second callback param. No-op if the
   *  agent isn't currently tracked (has never ticked). OS/mobile push is OUT OF SCOPE here — deferred
   *  to the companion (t-fe52f0/t-619157); this wiring is Attention Stack + badge only. */
  flagAwaitingHuman(agent: string, reason: string): void {
    const snap = this.snaps.get(agent);
    if (!snap) return;
    snap.awaitingHuman = true;
    snap.awaitingHumanReason = reason;
    const notify = !snap.awaitingHumanNotified;
    snap.awaitingHumanNotified = true;
    this.onChange?.(agent, this.toAttention(agent, snap), notify);
  }

  /**
   * t-a39c7d — mark the finished turn as awaiting human eyes (done = idle + unseen).
   * Used on working→idle and when notify_agent rings the completion doorbell.
   */
  flagUnseen(agent: string): void {
    const snap = this.snaps.get(agent);
    if (!snap) return;
    if (snap.unseen) return;
    snap.unseen = true;
    this.onChange?.(agent, this.toAttention(agent, snap), false);
  }

  /**
   * t-a39c7d — human looked at the pane (sidebar click / open terminal). Decays done→idle.
   */
  markSeen(agent: string): void {
    const snap = this.snaps.get(agent);
    if (!snap || !snap.unseen) return;
    snap.unseen = false;
    this.onChange?.(agent, this.toAttention(agent, snap), false);
  }

  isUnseen(agent: string): boolean {
    return this.snaps.get(agent)?.unseen ?? false;
  }

  needsInputCount(): number {
    let n = 0;
    for (const snap of this.snaps.values()) if (snap.state === "needs-input") n++;
    return n;
  }

  private lastMatch = new Map<string, TailClassification>();

  async tick(): Promise<void> {
    // A slow tmux/capture call is never allowed to build an overlapping queue. The original
    // work is left to settle naturally; callers regain control at the deadline and later ticks
    // skip until it does, without sharing the Bridge/tool request path or acquiring a lock.
    if (this.tickRunning) {
      this.stale = true;
      return;
    }
    const work = this.runTick();
    this.tickRunning = work;
    void work.finally(() => {
      if (this.tickRunning === work) this.tickRunning = undefined;
    }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.tickDeadlineMs);
    });
    let result: "complete" | "timeout";
    try {
      result = await Promise.race([work.then(() => "complete" as const), timeout]);
    } catch (error) {
      this.stale = true;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result === "timeout") {
      this.stale = true;
      return;
    }
    this.stale = false;
  }

  private async runTick(): Promise<void> {
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
      const activityAt = this.io.windowActivity?.(agent) ?? null;
      let snap = this.snaps.get(agent);

      // t-4ecf9a — selective capture when the control-mode activity feed is live: skip
      // capturePane for panes whose #{window_activity} is unchanged and that have already
      // had a silence-threshold confirmatory capture. null activityAt = engine down / unknown
      // session → poll every tick (same structural fallback as the dead-map).
      const capture = !snap || this.shouldCapture(snap, activityAt, settings, now);
      let content: string;
      if (!capture && snap) {
        content = snap.content;
      } else {
        try {
          content = (await this.io.capturePane(agent)).replace(/\s+$/, "");
        } catch {
          continue; // session vanished between list and capture
        }
      }

      if (!snap) {
        const initialMatch = this.classifyForPrecedence(agent, content, settings.patterns);
        const initialComposer = await this.composerSnapshot(agent, content);
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
          authRequired: undefined,
          authRequiredNotified: false,
          authSince: null,
          authKey: null,
          unseen: false,
          // A first capture can land mid-turn. Runtime activity chrome is positive evidence of work;
          // the synthetic initial `working` state is not. A quiet empty prompt therefore remains false.
          hasStartedTurn: this.hasActivitySignal(
            agent,
            content,
            initialComposer.composerOccupied && initialComposer.composerEvidence,
          ) ? true : this.io.initialTurnState?.(agent),
          matchSince: initialMatch ? now : null,
          matchKey: initialMatch ? initialMatch.pattern : null,
          lastWindowActivity: activityAt,
          lastCaptureAt: now,
          composerDraftNotified: false,
          ...initialComposer,
        };
        this.snaps.set(agent, snap);
        continue;
      }

      if (capture) {
        snap.lastCaptureAt = now;
        snap.lastWindowActivity = activityAt;
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
        const wasComposerOccupied = snap.composerOccupied;
        snap.content = content;
        const composer = await this.composerSnapshot(agent, content);
        snap.composerOccupied = composer.composerOccupied;
        snap.composerEvidence = composer.composerEvidence;
        this.evaluateStall(agent, snap, now);
        if (wasComposerOccupied !== snap.composerOccupied) {
          if (!snap.composerOccupied) snap.composerDraftNotified = false;
          const draftNeedsHuman = snap.composerOccupied && snap.state === "idle" && !snap.composerDraftNotified;
          if (draftNeedsHuman) snap.composerDraftNotified = true;
          // t-dd130a — `notify` stays false here for the same reason as in transition(): it means
          // "this transition earns a one-shot notification" and consumers read it combined with
          // other snapshot fields. The draft warning travels as `cause`, which is the channel the
          // Workspace consumer switches on. This is the SECOND of the two emitters that carried the
          // draft; fixing only the other one left the defect alive, which the gate caught.
          this.onChange?.(agent, this.toAttention(agent, snap), false, draftNeedsHuman ? "composer-draft" : undefined);
        }
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
        // Composer-only changes returned above: typing a draft is not starting a turn. Every other
        // pane-output change is the production observation that work reached the runtime.
        snap.hasStartedTurn = true;
        const wasComposerOccupied = snap.composerOccupied;
        const composer = await this.composerSnapshot(agent, content);
        snap.composerOccupied = composer.composerOccupied;
        snap.composerEvidence = composer.composerEvidence;
        if (wasComposerOccupied && !snap.composerOccupied) snap.composerDraftNotified = false;
      }

      // t-5bfb72 — track how long the runtime's own "you are not authenticated" line has been sitting
      // in the tail. Tracked on every tick (not only once idle) so the debounce is already satisfied
      // by the time the pane goes quiet; the LATCH itself is taken in the idle branch below, because
      // "idle" is the state this whole spec exists to disambiguate.
      this.trackAuthSignal(agent, snap, content, now);

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
      const match = this.classifyForPrecedence(agent, content, settings.patterns);
      if (match) {
        if (match.skipStateUpdate) {
          snap.matchSince = null;
          snap.matchKey = null;
          continue;
        }
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
        // t-30ff0d — before calling a still pane idle, ask the pane whether the runtime still owes
        // this turn work. An agent that handed a command to a background shell (or an MCP server, or
        // a monitor) freezes its pane AND stops burning CPU, so both inputs above read as idle while
        // it is plainly mid-flight — the sidebar then shows a whole fleet as stopped. This is the
        // runtime's own measured statement, bounded to the bottom of the pane; it is not CPU
        // (t-285503's flap) and not process existence.
        if (this.hasActivitySignal(agent, snap.content, snap.composerOccupied && snap.composerEvidence)) {
          this.transition(agent, snap, "working", now);
          continue;
        }
        this.transition(agent, snap, "idle", now);
        this.detectAwaitingHumanOnIdle(agent, snap);
        this.detectAuthRequiredOnIdle(agent, snap, now);
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
  private classifyForPrecedence(agent: string, content: string, patterns: RegExp[]): TailClassification | null {
    const runtime = this.manifestRuntimeFromCmd(agent);
    const match = classifyAttentionTail(content, patterns, runtime);
    return match && match.distanceFromBottom <= PATTERN_POSITION_TOLERANCE ? match : null;
  }

  /**
   * t-4ecf9a — whether this tick should call capturePane for an already-tracked agent.
   * Poll when activity feed is null; otherwise capture on activity change or the first tick
   * after the silence threshold (confirmatory recheck), then skip until activity moves again.
   */
  private shouldCapture(
    snap: Snapshot,
    activityAt: number | null,
    settings: AttentionSettings,
    now: number,
  ): boolean {
    if (activityAt === null) return true;
    if (snap.lastWindowActivity === null) return true;
    if (activityAt !== snap.lastWindowActivity) return true;
    const silenceDeadline = snap.contentSince + settings.silenceSec * 1000;
    if (now >= silenceDeadline && snap.lastCaptureAt < silenceDeadline) return true;
    return false;
  }

  private transition(agent: string, snap: Snapshot, state: AttentionState, now: number): void {
    if (snap.state === state) return;
    const prev = snap.state;
    const isNewTurnEdge = prev !== "working" && state === "working";
    // t-a39c7d — working→idle means a finished turn awaiting eyes; new working clears it.
    if (prev === "working" && state === "idle" && snap.hasStartedTurn) snap.unseen = true;
    if (state === "working") snap.unseen = false;
    snap.state = state;
    snap.stateSince = now;
    if (isNewTurnEdge && snap.awaitingHuman) {
      snap.awaitingHuman = false;
      snap.awaitingHumanReason = undefined;
      snap.awaitingHumanNotified = false;
    }
    // t-5bfb72 — a new turn is the observable proof that the hold is over: an agent whose runtime
    // refuses to authenticate cannot start one. This is what makes recovery EXPLICIT without a
    // dedicated clear-API — a human logs in and restarts (or retries), the agent works, the latch
    // drops. It is also what bounds a false positive to a single quiet episode instead of forever.
    // If the login was not actually fixed, the runtime answers the same notice and this re-latches.
    if (isNewTurnEdge && snap.authRequired) {
      snap.authRequired = undefined;
      snap.authRequiredNotified = false;
      snap.authSince = null;
      snap.authKey = null;
    }
    // t-dd130a — the unsent-draft warning rides its own channel, NOT `notify`. `notify` already
    // means "this transition earns a one-shot notification", and consumers filter on it combined
    // with other snapshot fields: snHandbackBehavior counts `notify && awaitingHuman` to prove the
    // awaiting-human one-shot fires exactly twice. Folding the draft warning into the same boolean
    // made a draft typed during an awaiting-human episode read as a THIRD awaiting-human
    // notification. One flag, one meaning: the draft travels as `cause` instead, which is what the
    // Workspace consumer switches on.
    const draftNeedsHuman = state === "idle" && snap.composerOccupied && !snap.composerDraftNotified;
    if (draftNeedsHuman) snap.composerDraftNotified = true;
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
    this.onChange?.(
      agent,
      this.toAttention(agent, snap),
      notify,
      draftNeedsHuman ? "composer-draft" : undefined,
    );
  }

  /**
   * t-5bfb72 — maintain the stability window for the measured auth signal. Keyed on the matched LINE
   * rather than the pattern: unlike a rate-limit countdown, these notices do not tick, so a changed
   * line genuinely is a different notice and deserves a fresh window.
   */
  private trackAuthSignal(agent: string, snap: Snapshot, content: string, now: number): void {
    const evidence = classifyAuthRequired(this.manifestRuntimeFromCmd(agent), content, {
      tailLines: AUTH_SIGNAL_TAIL_LINES,
    });
    if (!evidence) {
      snap.authSince = null;
      snap.authKey = null;
      return;
    }
    if (snap.authKey !== evidence.matchedLine) {
      snap.authSince = now;
      snap.authKey = evidence.matchedLine;
    }
  }

  /**
   * t-5bfb72 — take the latch once a stable, measured auth signal has outlived the pane going quiet.
   *
   * Deliberately gated on idle. The signal's whole purpose is to tell "finished its turn" apart from
   * "cannot execute another one", and only an idle agent is ambiguous in that way; requiring idle also
   * keeps the same bytes appearing mid-turn — a file being read, a test fixture, this very spec — from
   * parking an agent that is plainly still working.
   *
   * Nothing here stops, kills or rewinds anything. The latch's only powers are to ask for a human and
   * to withhold AUTOMATIC restart/retry, so the cost of being wrong is a badge and a paused robot,
   * while the cost of not latching is a queue burned against a login prompt.
   */
  private detectAuthRequiredOnIdle(agent: string, snap: Snapshot, now: number): void {
    if (snap.authRequired) return;
    if (snap.authSince === null) return;
    if (now - snap.authSince < PATTERN_STABLE_MS) return;
    const evidence = classifyAuthRequired(this.manifestRuntimeFromCmd(agent), snap.content, {
      tailLines: AUTH_SIGNAL_TAIL_LINES,
    });
    if (!evidence) return;
    snap.authRequired = evidence;
    const notify = !snap.authRequiredNotified;
    snap.authRequiredNotified = true;
    this.onChange?.(agent, this.toAttention(agent, snap), notify);
  }

  private detectAwaitingHumanOnIdle(agent: string, snap: Snapshot): void {
    if (!this.io.awaitingHumanOnIdle?.(agent)) return;
    if (snap.awaitingHuman) return;
    const question = extractAwaitingHumanQuestion(snap.content);
    if (!question) return;
    this.flagAwaitingHuman(agent, question);
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

  private manifestRuntimeFromCmd(agent: string): ResumeRuntime | undefined {
    const cmd = this.io.cmdOf?.(agent) ?? "";
    return cmd ? (runtimeOf(cmd) ?? undefined) : undefined;
  }

  /**
   * t-30ff0d — does the pane itself say work is still in flight? Bounded to the runtime's declared
   * tail so the same claim, once scrolled into transcript history, cannot pin the agent forever.
   */
  private hasActivitySignal(agent: string, content: string, composerOccupied: boolean): boolean {
    // t-2b5db1 — a human-owned, unsubmitted composer is an intervention boundary. A residual
    // shell counter may survive the turn that left the draft behind, but treating that counter as
    // active work pins the agent at `working` forever and suppresses the idle/backstop notice that
    // tells the owner the instruction was never submitted. Keep the orthogonal signal visible via
    // `composerOccupied`; do not auto-submit or discard the human's text.
    if (composerOccupied) return false;
    const cmd = this.io.cmdOf?.(agent) ?? "";
    const runtime = cmd ? runtimeOf(cmd) : null;
    const activity = runtime ? runtimeProfile(runtime)?.activity : undefined;
    if (!activity) return false;
    const lines = content.split("\n").filter((line) => stripAnsi(line).trim().length > 0);
    const running = lines
      .slice(Math.max(0, lines.length - activity.tailLines))
      .some((line) => activity.runningLine.test(stripAnsi(line)));
    if (!running) return false;
    if (!activity.settledLine) return true;
    const settledTailLines = activity.settledTailLines ?? activity.tailLines;
    const settled = lines
      .slice(Math.max(0, lines.length - settledTailLines))
      .some((line) => activity.settledLine!.test(stripAnsi(line)));
    // t-ca4a3c — an explicit handback at the stable composer is newer evidence about the turn than
    // a residual shell/monitor counter in the mode line. The positive t-30ff0d case has the counter
    // but no handback and therefore remains working.
    return !settled;
  }

  private isComposerOnlyChange(agent: string, previous: string, next: string): boolean {
    const composer = this.composerProfileOf(agent);
    return composer ? isChangeConfinedToComposer(previous, next, composer) : false;
  }

  private composerProfileOf(agent: string) {
    const cmd = this.io.cmdOf?.(agent) ?? "";
    const runtime = cmd ? runtimeOf(cmd) : null;
    return runtime ? runtimeProfile(runtime)?.composer : undefined;
  }

  /**
   * t-a53dd9 — the human-draft signal read AT THE MOMENT OF INJECTION, not from the poll.
   *
   * `stateOf(agent).composerOccupied` is a CACHED reading. It is recomputed only when a tick captures
   * the pane, and a tick captures at most every ATTENTION_POLL_MS (3s), skips panes whose
   * `#{window_activity}` has not moved (`shouldCapture`), and keeps serving the last value while a
   * slow pass is over its deadline (`stale`). Every consumer that guarded a pane WRITE with that
   * value was therefore asking "was a draft there up to several seconds ago?" while the write happens
   * now — and on 2026-08-02 the answer diverged in the direction that costs the most: the workspace
   * owner was typing into the `claude` coordinator pane, a `notify_agent` doorbell read the pre-typing
   * snapshot as free, and the injected line was submitted together with his half-written message.
   *
   * This closes the window to a single capture→write round-trip (measured in tens of ms) instead of
   * the poll interval. It cannot close it completely: tmux has no compare-and-write, so a keystroke
   * landing between this capture and the send is still possible. That residue is the honest bound and
   * is stated in `notify_agent`'s description rather than papered over.
   *
   * Return values are three-valued ON PURPOSE and callers must not flatten them:
   *   - `true` / `false`  — measured now, from this runtime's declared composer region.
   *   - `undefined`       — NO OBSERVABLE SIGNAL: the entry is a terminal (`cmdOf` returns null for
   *                         those), the runtime is unrecognized, or its profile declares no composer.
   *                         An undefined is not "the composer is clear"; it is "this runtime cannot
   *                         answer", and the caller falls back to the cached poll rather than
   *                         inventing a shape for a runtime nobody measured.
   * An unreadable pane (capture threw) also degrades to the last cached reading: failing to read a
   * pane is never evidence that the human stopped typing in it.
   */
  async probeComposerOccupied(agent: string): Promise<boolean | undefined> {
    if (!this.composerProfileOf(agent)) return undefined;
    let content: string;
    try {
      content = (await this.io.capturePane(agent)).replace(/\s+$/, "");
    } catch {
      return this.snaps.get(agent)?.composerOccupied;
    }
    // Deliberately routed through the SAME reader the tick uses (escaped capture for runtimes with a
    // measured suggestion rule, plain otherwise). A second copy of this decision is how one runtime
    // ends up measured once and fixed twice.
    return (await this.composerSnapshot(agent, content)).composerOccupied;
  }

  /**
   * t-e169e4 — fresh text for the narrower question "is the composer holding the exact queued line
   * Tachyon already typed?". Undefined stays fail-closed: without a profile or readable pane there is
   * no ownership evidence, so callers must continue treating occupied content as human-owned.
   */
  async probeComposerText(agent: string): Promise<string | undefined> {
    const composer = this.composerProfileOf(agent);
    if (!composer) return undefined;
    try {
      const content = this.io.capturePaneEscaped
        ? await this.io.capturePaneEscaped(agent, composer.tailLines)
        : await this.io.capturePane(agent);
      if (!findComposerRegion(content.split("\n"), composer)) return undefined;
      return composerText(content, composer) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async composerSnapshot(agent: string, content: string): Promise<{ composerOccupied: boolean; composerEvidence: boolean }> {
    const composer = this.composerProfileOf(agent);
    if (!composer) return { composerOccupied: false, composerEvidence: false };
    if (composer.ansiEmptyContentStyle && this.io.capturePaneEscaped) {
      try {
        const styledContent = (await this.io.capturePaneEscaped(agent, composer.tailLines)).replace(/\s+$/, "");
        const occupied = isComposerOccupied(styledContent, composer);
        return {
          composerOccupied: occupied,
          // A colored status line elsewhere in the tail is not proof that a prompt-shaped history
          // line is a live draft. Scope the ANSI evidence to an occupied composer line itself.
          composerEvidence: occupied && this.composerHasAnsiEvidence(styledContent, composer),
        };
      } catch {
        return { composerOccupied: isComposerOccupied(content, composer), composerEvidence: false };
      }
    }
    return { composerOccupied: isComposerOccupied(content, composer), composerEvidence: !composer.ansiEmptyContentStyle };
  }

  private composerHasAnsiEvidence(content: string, composer: NonNullable<ReturnType<typeof runtimeProfile>>["composer"]): boolean {
    if (!composer) return false;
    const lines = content.split("\n");
    const region = findComposerRegion(lines, composer);
    if (!region) return false;
    const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/;
    return lines.slice(region.start, region.end).some((line) => composer.occupiedLine.test(stripAnsi(line)) && ansi.test(line));
  }
}

/** t-10771a — a narrow "agent ended its turn with a prose question" detector.
 *  Selector prompts and terminal mechanics stay in patterns.ts; this is only for natural-language
 *  handback that should raise the existing awaiting-human latch after the pane has gone idle. */
export function extractAwaitingHumanQuestion(content: string): string | undefined {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-PROSE_QUESTION_TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripQuestionPrefix(lines[i]);
    if (!line || line.length > PROSE_QUESTION_MAX_CHARS) continue;
    if (!/[?][)"'\]]*\s*$/.test(line)) continue;
    if (looksLikeMechanicalPrompt(line)) continue;
    return line;
  }
  return undefined;
}

function stripQuestionPrefix(line: string): string {
  return line.replace(/^(?:[>\-*•]\s*)+/, "").trim();
}

function looksLikeMechanicalPrompt(line: string): boolean {
  return (
    /\b(?:\[y\/n\]|\(y\/n\)|yes\/no|press enter|enter to confirm|esc to cancel|select an option)\b/i.test(line) ||
    /^(?:[❯>$#]\s*)/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    /^[\w.-]+@[\w.-]+[:$]/.test(line) ||
    /^[\[{].*[\]}],?\s*$/.test(line) ||
    /^https?:\/\//i.test(line) ||
    /^[\w./-]+\s+\?/.test(line) ||
    /\b(?:continue|proceed)\?\s*$/i.test(line)
  );
}
