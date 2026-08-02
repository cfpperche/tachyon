import { MAX_WORKING_STALL_MS, type AgentAttention } from "../attention/AttentionMonitor.js";
import type { ManagedEntryInfo } from "../agents/AgentManager.js";
import type { NoticeQueueMetadata } from "../bridge/NoticeQueue.js";

export const DEFAULT_TEMPORARY_BACKSTOP_THRESHOLD_MS = 10 * 60_000;

/**
 * t-0bebf6 — the acknowledgement ladder: the ONE place the backoff is written down.
 *
 * The poke had four exits (inspect / dismiss / resume / re-delegate) and no way to say "I know". A
 * coordinator who had already inspected a child and decided to leave it alone had no answer to give,
 * so the only thing the product could read from that decision was silence — and silence looks exactly
 * like nobody having seen the line yet.
 *
 * `acknowledge` is the fifth exit. It does NOT mute the child: it says "I have decided about the
 * child in THIS state", and the monitor stays quiet only while that state holds. These multiples of
 * the idle threshold are where an acknowledged child comes back anyway, because staying idle four
 * times longer than the window you acknowledged IS a change worth one line. They are multiples rather
 * than absolute durations so a workspace that configured a 2-minute window gets a 2-minute-shaped
 * ladder, and the delivered line always names the next rung — the backoff is legible from the notice
 * itself, not only from this file.
 *
 * Past the last rung the spacing REPEATS (see `acknowledgedCheckInMs`). An acknowledgement is a
 * deferral, never a permanent mute: a child idle overnight still surfaces once per final-rung
 * interval, and it never stops being visible in Attention regardless of what this monitor says.
 */
export const ACKNOWLEDGED_ESCALATION_MULTIPLES = [4, 16, 64] as const;

/**
 * How long an acknowledged child must stay in the SAME state before it is worth one more line.
 *
 * `step` walks `ACKNOWLEDGED_ESCALATION_MULTIPLES`; beyond its end the final multiple becomes a fixed
 * spacing (64×, 128×, 192× …) so the sequence keeps growing without ever reaching infinity.
 */
export function acknowledgedCheckInMs(thresholdMs: number, step: number): number {
  const ladder = ACKNOWLEDGED_ESCALATION_MULTIPLES;
  const last = ladder[ladder.length - 1];
  const multiple = step < ladder.length ? ladder[step] : last * (step - ladder.length + 2);
  return thresholdMs * multiple;
}

/** The first rung that is still ahead of `ms` — where an acknowledgement taken now should aim. */
function firstStepAbove(ms: number, thresholdMs: number): number {
  let step = 0;
  // Bounded so a pathological threshold (or a clock jump) cannot spin here; 64 rungs past a
  // 1-minute window is already years of silence, far beyond any session.
  while (step < 64 && acknowledgedCheckInMs(thresholdMs, step) <= ms) step++;
  return step;
}

/**
 * t-585d5c — the ONE place the configured value becomes a window in milliseconds.
 *
 * Lives beside the monitor that consumes it rather than in the config loader, so the unit conversion
 * and the code that compares against it cannot drift apart. Three inputs, three meanings:
 *   - `undefined` — nothing configured, so the shipped default stands (this is what keeps an
 *     unconfigured workspace behaving exactly as before);
 *   - `"never"` — switched off, expressed as `null` so the monitor has nothing to compare against;
 *   - a number — minutes, as written by a human, converted once here.
 *
 * Validation already happened at the config edge; a value that got here is one the loader accepted.
 */
export function idleNotifyThresholdMs(configured: number | "never" | undefined): number | null {
  if (configured === undefined) return DEFAULT_TEMPORARY_BACKSTOP_THRESHOLD_MS;
  if (configured === "never") return null;
  return Math.round(configured * 60_000);
}

export interface TemporaryBackstopDeps {
  listEntries(): Promise<ManagedEntryInfo[]>;
  attentionOf(agent: string): AgentAttention | undefined;
  now(): number;
  deliverNotice(parent: string, line: string, metadata?: NoticeQueueMetadata): Promise<unknown>;
  /** t-fb1453 — a host-authored observation ABOUT a child; it expires with that child by design. */
  sourceNoticeMetadata?(agent: string): NoticeQueueMetadata;
  /** t-9552f3 — true when the child already rang notify_agent this session (completion hint). */
  completionHinted?(agent: string): boolean;
}

type BackstopReason = "idle" | "working";

/** What the last delivered poke said about a child, and whether its coordinator answered. */
interface PokeRecord {
  reason: BackstopReason;
  episodeKey: string;
  /** The duration the last delivered line named — what the coordinator was actually told. */
  reportedMs: number;
  /**
   * Present once the coordinator answered "already decided" for the poke above. It keeps the
   * ACKNOWLEDGED state, not the current one, so a follow-up line can say what changed since.
   */
  ack?: { reason: BackstopReason; reportedMs: number; step: number };
}

/** t-0bebf6 — what `acknowledge` recorded, so the caller can see the deferral it just took. */
export interface BackstopAcknowledgement {
  agent: string;
  reason: BackstopReason;
  /** Idle/silent duration named by the poke that was acknowledged. */
  idleMs: number;
  /** Idle duration at which this child surfaces again anyway; null only when the nudge is switched off. */
  nextCheckInMs: number | null;
}

export class TemporaryBackstopMonitor {
  /**
   * t-0bebf6 — per-child poke state. In memory by design, exactly like the episode dedupe it
   * replaces: an extension reload rebuilds the workspace and every child gets a fresh hearing, which
   * is the safe direction to fail (a lost acknowledgement costs one line; a persisted one could
   * outlive the decision it recorded).
   */
  private readonly poked = new Map<string, PokeRecord>();

  /**
   * t-585d5c — the threshold may be a FUNCTION, resolved per tick instead of captured here.
   *
   * This monitor is constructed once, in the `Workspace` constructor. A number frozen at that moment
   * could only change by rebuilding the workspace — which means recreating agents, exactly what a
   * configurable threshold must not require. A resolver reads the live config on each pass, so an
   * edit takes effect on the next tick: no restart, and no second timer racing this one.
   *
   * `"never"` reaches this layer as `null`. The off-vocabulary is spoken at the config edge; here it
   * only has to mean "no threshold", which `tick` reads as "nudge about nothing".
   */
  constructor(
    private readonly deps: TemporaryBackstopDeps,
    private readonly threshold: number | null | (() => number | null) = DEFAULT_TEMPORARY_BACKSTOP_THRESHOLD_MS,
  ) {}

  /** The window in force for THIS pass, or null when the nudge is switched off. */
  private resolveThresholdMs(): number | null {
    return typeof this.threshold === "function" ? this.threshold() : this.threshold;
  }

  reset(agent: string): void {
    this.poked.delete(agent);
  }

  /**
   * t-0bebf6 — the fifth exit: "I inspected this child and decided to leave it as it is."
   *
   * Only answers an OUTSTANDING poke. Acknowledging a child nobody was asked about returns null and
   * records nothing, because a pre-emptive acknowledgement would be a mute — and a mute applied
   * before the first question is the failure this task exists to avoid, not the fix.
   *
   * Who else can reach this? The poke is typed into the parent AGENT's pane, so the acknowledging
   * actor is that agent through the Bridge (`acknowledge_agent`); there is no Interface surface to
   * answer, because a human never receives this line. Tachyon itself reaches the same state through
   * `reset` (spawn/restart/kill) and through the live-name sweep in `tick` when a child stops
   * running — both DROP the record, so a re-delegated or resurrected child is asked about again.
   */
  acknowledge(agent: string): BackstopAcknowledgement | null {
    const record = this.poked.get(agent);
    if (!record) return null;
    const thresholdMs = this.resolveThresholdMs();
    if (!record.ack) {
      record.ack = {
        reason: record.reason,
        reportedMs: record.reportedMs,
        step: thresholdMs === null ? 0 : firstStepAbove(record.reportedMs, thresholdMs),
      };
    }
    return {
      agent,
      reason: record.ack.reason,
      idleMs: record.ack.reportedMs,
      nextCheckInMs: thresholdMs === null ? null : acknowledgedCheckInMs(thresholdMs, record.ack.step),
    };
  }

  async tick(): Promise<void> {
    const thresholdMs = this.resolveThresholdMs();
    // Off means off for the WHOLE pass, decided before any work: nothing is listed, nothing is
    // classified, and no episode is marked as nudged — so switching back on later behaves like the
    // agent had simply been quiet, not like its nudge was already spent.
    if (thresholdMs === null) return;
    const now = this.deps.now();
    const entries = await this.deps.listEntries();
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const liveNames = new Set(entries.filter((entry) => entry.running).map((entry) => entry.name));

    for (const [agent] of this.poked) {
      if (!liveNames.has(agent)) this.poked.delete(agent);
    }

    for (const entry of entries) {
      if (entry.kind !== "agent" || !entry.parent || !entry.running) continue;
      const parent = byName.get(entry.parent);
      if (!parent?.running) continue;

      const attention = this.deps.attentionOf(entry.name);
      if (!attention || attention.state === "needs-input" || attention.state === "throttled") continue;
      if (attention.state !== "idle" && attention.state !== "working") continue;

      // t-9552f3 — child already notified parent (completion doorbell). Do not treat a
      // stuck "working" classification as an active-work stall; idle-style nudge is enough
      // if silence is long, and "still listed as working" after notify is a false alarm.
      const completionHinted = this.deps.completionHinted?.(entry.name) === true;
      let effectiveState = attention.state;
      if (completionHinted && attention.state === "working" && !attention.composerOccupied) {
        effectiveState = "idle";
      }

      const stableSince = attention.outputStableSince ?? attention.contentSince ?? attention.since;
      const stableMs = now - stableSince;
      if (stableMs < thresholdMs) continue;
      if (effectiveState === "working" && stableMs < Math.max(thresholdMs, MAX_WORKING_STALL_MS)) continue;
      // After notify, skip the long working-stall path entirely — session may stay open for postmortem.
      if (completionHinted && attention.state === "working") {
        // only the idle message path (or silence) — already remapped to idle above
      }

      const reason: BackstopReason = effectiveState;
      const episodeKey = attention.episodeKey ?? String(stableSince);
      const record = this.poked.get(entry.name);

      let line: string;
      let ack: PokeRecord["ack"];
      if (record?.ack) {
        const change = describeChange(record, reason, episodeKey, stableMs, thresholdMs);
        // t-0bebf6 — the fifth exit doing its work: acknowledged, nothing changed, nothing said.
        // This is the ONLY branch that suppresses a line, and it is reachable only because someone
        // answered the previous one.
        if (!change) continue;
        const acknowledged = `acknowledged ${describeState(record.ack.reason)} at ${formatDuration(record.ack.reportedMs)}`;
        if (change.keepAck) {
          // Still the state that was acknowledged, only longer. The decision stands, so the record
          // keeps it and only the rung moves — and the line names the next rung, which is what makes
          // the backoff explicable to the reader instead of a number buried in this file.
          const step = firstStepAbove(stableMs, thresholdMs);
          ack = { ...record.ack, step };
          line =
            `[tachyon] child '${entry.name}' — ${acknowledged}, ${change.text}; ` +
            `next check-in at ${formatDuration(acknowledgedCheckInMs(thresholdMs, step))} unless something changes — ${SETTLED_DOORS}`;
        } else {
          // Something the acknowledgement did not cover. The decision was about the old state, so the
          // acknowledgement is spent and the child is a live question again.
          line = `[tachyon] child '${entry.name}' — ${acknowledged}, ${change.text} — ${openDoors(entry.name)}`;
        }
      } else {
        // Unacknowledged: one line per (child, reason, output episode), unchanged.
        if (record && record.reason === reason && record.episodeKey === episodeKey) continue;
        line =
          reason === "idle"
            ? `[tachyon] child '${entry.name}' has been idle for ${formatDuration(stableMs)} with no new output — ${openDoors(entry.name)}`
            : `[tachyon] child '${entry.name}' has produced no output for ${formatDuration(stableMs)} while still listed as working — ${openDoors(entry.name)}`;
      }

      this.poked.set(entry.name, { reason, episodeKey, reportedMs: stableMs, ack });
      await this.deps.deliverNotice(entry.parent, line, this.deps.sourceNoticeMetadata?.(entry.name)).catch(() => undefined);
    }
  }
}

/** The four exits that always existed, for a line that is reporting rather than asking. */
const SETTLED_DOORS = "inspect Activity/read_output, dismiss, resume, or re-delegate";

/** The same four plus the fifth, offered whenever the child is an open question. */
function openDoors(agent: string): string {
  return `inspect Activity/read_output, dismiss, resume, re-delegate, or acknowledge_agent('${agent}') if you have already decided`;
}

function describeState(reason: BackstopReason): string {
  return reason === "idle" ? "idle" : "silent while working";
}

/**
 * t-0bebf6 — the whole policy of "when may an acknowledged child interrupt again", in one function.
 *
 * Every branch returns TEXT, because the requirement is not only that the line comes back: it is that
 * it says what changed. A returning notice that repeats the original wording is the defect, not the
 * fix. `keepAck` distinguishes "the state you decided about, only longer" (the decision stands, the
 * ladder advances) from "something you did not decide about" (the acknowledgement is spent).
 */
function describeChange(
  record: PokeRecord,
  reason: BackstopReason,
  episodeKey: string,
  stableMs: number,
  thresholdMs: number,
): { text: string; keepAck: boolean } | null {
  const ack = record.ack;
  if (!ack) return null;
  if (reason !== ack.reason) {
    return {
      text:
        reason === "working"
          ? `now listed as working with no output for ${formatDuration(stableMs)}`
          : `now idle for ${formatDuration(stableMs)}`,
      keepAck: false,
    };
  }
  if (episodeKey !== record.episodeKey) {
    // A new output episode means the child actually emitted something after the acknowledgement and
    // then went quiet again past the threshold — it moved, so the decision is stale.
    return {
      text: `has produced new output since, and is ${describeState(reason)} again for ${formatDuration(stableMs)}`,
      keepAck: false,
    };
  }
  if (stableMs >= acknowledgedCheckInMs(thresholdMs, ack.step)) {
    return {
      text: `still ${describeState(reason)} and now silent for ${formatDuration(stableMs)}`,
      keepAck: true,
    };
  }
  return null;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}
