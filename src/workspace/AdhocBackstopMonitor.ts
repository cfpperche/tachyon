import { MAX_WORKING_STALL_MS, type AgentAttention } from "../attention/AttentionMonitor.js";
import type { ManagedEntryInfo } from "../agents/AgentManager.js";

export const DEFAULT_ADHOC_BACKSTOP_THRESHOLD_MS = 10 * 60_000;

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
  if (configured === undefined) return DEFAULT_ADHOC_BACKSTOP_THRESHOLD_MS;
  if (configured === "never") return null;
  return Math.round(configured * 60_000);
}

export interface AdhocBackstopDeps {
  listEntries(): Promise<ManagedEntryInfo[]>;
  attentionOf(agent: string): AgentAttention | undefined;
  now(): number;
  deliverNotice(parent: string, line: string, metadata?: { sourceChild?: string; sourceIncarnation?: number }): Promise<unknown>;
  sourceNoticeMetadata?(agent: string): { sourceChild?: string; sourceIncarnation?: number };
  /** t-9552f3 — true when the child already rang notify_agent this session (completion hint). */
  completionHinted?(agent: string): boolean;
}

type BackstopReason = "idle" | "working";

export class AdhocBackstopMonitor {
  private readonly nudgedEpisode = new Map<string, string>();

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
    private readonly deps: AdhocBackstopDeps,
    private readonly threshold: number | null | (() => number | null) = DEFAULT_ADHOC_BACKSTOP_THRESHOLD_MS,
  ) {}

  /** The window in force for THIS pass, or null when the nudge is switched off. */
  private resolveThresholdMs(): number | null {
    return typeof this.threshold === "function" ? this.threshold() : this.threshold;
  }

  reset(agent: string): void {
    this.nudgedEpisode.delete(agent);
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

    for (const [agent] of this.nudgedEpisode) {
      if (!liveNames.has(agent)) this.nudgedEpisode.delete(agent);
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
      const key = `${reason}:${attention.episodeKey ?? String(stableSince)}`;
      if (this.nudgedEpisode.get(entry.name) === key) continue;
      this.nudgedEpisode.set(entry.name, key);

      const line =
        reason === "idle"
          ? `[tachyon] child '${entry.name}' has been idle for ${formatDuration(stableMs)} with no new output — inspect Activity/read_output, dismiss, resume, or re-delegate`
          : `[tachyon] child '${entry.name}' has produced no output for ${formatDuration(stableMs)} while still listed as working — inspect Activity/read_output, dismiss, resume, or re-delegate`;
      await this.deps.deliverNotice(entry.parent, line, this.deps.sourceNoticeMetadata?.(entry.name)).catch(() => undefined);
    }
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}
