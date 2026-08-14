import type { ManagedEntryInfo } from "../agents/AgentManager.js";
import type { NoticeQueueMetadata } from "../bridge/NoticeQueue.js";
import type {
  RuntimeConditionReportV1,
  RuntimeQuotaWindowV1,
} from "../runtimeOps/runtimeCondition.js";

/**
 * t-458497 — the campainha: when a runtime's slack comes back, the coordinator is TOLD.
 *
 * The read tool beside this one answers a question; that is not enough, because it requires the agent
 * to remember to ask. The case this was filed over is exactly that failure: a coordinator avoided
 * delegating to Claude for hours after its 5h window reset, because nothing said the window had
 * reopened. A door that only opens inward stays shut.
 *
 * ## What it will and will not say
 *
 * It speaks ONLY from observations. A window it watched go under pressure, and then observed back
 * with room, is one line. A reset time a channel never gave is never invented into an announcement:
 * where the channel names one (Codex does), the line quotes it as corroboration; where it does not,
 * the line says so and reports the observed change instead of a predicted one. Nothing here schedules
 * a timer against a boundary Tachyon guessed.
 *
 * ## Repetition
 *
 * Handled the same way the idle poke handles it (`TemporaryBackstopMonitor`): with STATE, not with a
 * rule of thumb. A window that relieves is announced once and then disarmed; it can only speak again
 * after it has been observed under pressure again. The two thresholds below are separated on purpose
 * so a value hovering at the boundary cannot ring twice.
 *
 * State is in memory by design, exactly like the poke record it is modelled on. A daemon restart
 * during a throttle means the pressure was never observed by THIS process, so the relief is not
 * announced — silence, rather than a claim about an edge nobody watched. The condition is still one
 * `runtime_condition` call away.
 *
 * ## Who else can reach this?
 *
 *  - Tachyon (this monitor, on the workspace heartbeat) is the only author of these lines.
 *  - An Agent reaches the same FACTS through the `runtime_condition` Bridge tool, which reads the same
 *    projection this monitor reads — one shape, two doors, so a poke and a query cannot disagree.
 *  - The Interface reads the same underlying observations through the Runtime Ops view.
 *  - Spawn/restart/dismiss of an agent does not touch this state: the subject here is a RUNTIME, not
 *    a child, so a roster change only changes who is listening.
 */

/**
 * Under this much of a window consumed, a coordinator starts steering work away from the runtime —
 * so this is the edge worth remembering, and the one whose release is worth a line.
 */
export const QUOTA_PRESSURE_PERCENT = 90;

/**
 * Relief is only called at a materially lower reading, not at the first tick under the pressure line.
 * A window resets to near zero, so a real reset clears this easily; a value drifting around 90 cannot
 * produce a second announcement without first crossing back over the pressure line above.
 */
export const QUOTA_RELIEF_PERCENT = 75;

export interface RuntimeSlackDeps {
  /** the SAME projection the Bridge tool answers from; must be a cached read, never a collection */
  condition(): RuntimeConditionReportV1 | undefined;
  listAgents(): Promise<ManagedEntryInfo[]>;
  deliverNotice(agent: string, line: string, metadata?: NoticeQueueMetadata): Promise<unknown>;
}

interface WindowPressure {
  /** the reading that put this window under pressure */
  usedPercent: number;
  observedAt: string;
  /** what the channel said about the reset, or null when it said nothing */
  resetsAt: string | null;
}

export class RuntimeSlackMonitor {
  /** runtime -> window name -> the pressure episode currently armed for it */
  private readonly pressured = new Map<string, Map<string, WindowPressure>>();

  constructor(private readonly deps: RuntimeSlackDeps) {}

  async tick(): Promise<void> {
    const report = this.deps.condition();
    if (!report) return;

    const lines: string[] = [];
    const live = new Set<string>();
    for (const runtime of report.runtimes) {
      live.add(runtime.runtime);
      const quota = runtime.capacity.quota;
      const channel = runtime.capacity.channel;
      // Only a FRESH reading moves this state machine. A stale last-good echo repeats numbers that
      // were already accounted for, and an unavailable envelope carries no numbers at all — reading
      // either as a change is how an absence turns into a false all-clear.
      if (quota.state !== "observed" || quota.freshness.state !== "fresh") continue;
      const integrity = channel.state === "present" ? channel.integrity : quota.integrity;

      let windows = this.pressured.get(runtime.runtime);
      if (!windows) {
        windows = new Map();
        this.pressured.set(runtime.runtime, windows);
      }
      const seen = new Set<string>();
      for (const window of quota.windows) {
        seen.add(window.name);
        const armed = windows.get(window.name);
        if (!armed) {
          if (window.usedPercent < QUOTA_PRESSURE_PERCENT) continue;
          windows.set(window.name, {
            usedPercent: window.usedPercent,
            observedAt: quota.observedAt,
            resetsAt: window.resetsAt,
          });
          continue;
        }
        if (window.usedPercent >= QUOTA_PRESSURE_PERCENT) {
          // Still under pressure. Re-anchor on the LATEST such reading so the eventual line compares
          // against what was true just before the relief — and so a reset time the channel revised
          // (a window that rolled while still full) is the one quoted, never a superseded one.
          windows.set(window.name, {
            usedPercent: window.usedPercent,
            observedAt: quota.observedAt,
            resetsAt: window.resetsAt,
          });
          continue;
        }
        // Between the two lines: armed, but not yet a relief worth a line. Left untouched on purpose —
        // this gap is what stops a value hovering at the boundary from ringing twice.
        if (window.usedPercent > QUOTA_RELIEF_PERCENT) continue;
        windows.delete(window.name);
        lines.push(reliefLine(runtime.runtime, window, armed, quota.observedAt, integrity));
      }
      // A window the channel stopped reporting is not a window that relieved; drop it unannounced.
      for (const name of [...windows.keys()]) if (!seen.has(name)) windows.delete(name);
      if (windows.size === 0) this.pressured.delete(runtime.runtime);
    }
    for (const runtime of [...this.pressured.keys()]) if (!live.has(runtime)) this.pressured.delete(runtime);

    if (lines.length === 0) return;
    const recipients = await this.coordinators();
    for (const recipient of recipients) {
      for (const line of lines) {
        await this.deps.deliverNotice(recipient, line).catch(() => undefined);
      }
    }
  }

  /**
   * The agents that delegate: running agent instances with no parent of their own.
   *
   * Derived from the live roster rather than configured, because "who is coordinating right now" is
   * not something a settings file knows. A child does not get this line — it is already inside the
   * work it was given, and the decision this unblocks (where to send the NEXT piece of work) belongs
   * to whoever hands work out.
   */
  private async coordinators(): Promise<string[]> {
    const entries = await this.deps.listAgents().catch(() => [] as ManagedEntryInfo[]);
    return entries
      .filter((entry) => entry.running && !entry.dead && !entry.parent)
      .map((entry) => entry.name);
  }
}

function reliefLine(
  runtime: string,
  window: RuntimeQuotaWindowV1,
  armed: WindowPressure,
  observedAt: string,
  integrity: "firm" | "best-effort",
): string {
  const scope = window.windowMinutes ? `${window.name} (${describeMinutes(window.windowMinutes)})` : window.name;
  const reset = armed.resetsAt
    ? `the channel named ${armed.resetsAt} as the reset and this reading is after it`
    : "this channel names no reset time, so this is an observed change and not a predicted one";
  const label = integrity === "best-effort" ? " (best-effort channel)" : "";
  return (
    `[tachyon] runtime '${runtime}' has slack again — its ${scope} quota window reads `
    + `${round(window.usedPercent)}% used at ${observedAt}, down from ${round(armed.usedPercent)}% at `
    + `${armed.observedAt}; ${reset}${label}. Delegation to '${runtime}' is no longer quota-blocked — `
    + "runtime_condition has the full picture."
  );
}

function describeMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function round(percent: number): number {
  return Math.round(percent * 10) / 10;
}
