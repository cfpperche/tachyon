import type { RestartPolicy } from "../config/loadConfig.js";

/** Backoff for restart: on-crash — then give up until a human intervenes. */
export const RESTART_DELAYS_MS = [2000, 4000, 8000];
export const RESTART_WINDOW_MS = 60_000;

export interface LifecycleIO {
  /** name -> session state (from AgentManager.agentStates) */
  agentStates(): Promise<Map<string, { dead: boolean; exitCode?: number }>>;
  policyOf(agent: string): RestartPolicy;
  /** wire to setTimeout(manager.restart) in the extension */
  scheduleRestart(agent: string, delayMs: number): void;
  /**
   * t-9d76b1 — did TACHYON ask this agent to exit? Optional so a caller that cannot answer keeps the
   * previous behaviour exactly; absent means "no request known", never "it crashed".
   */
  wasStopRequested?(agent: string): boolean;
  now(): number;
}

export interface LifecycleEvents {
  /** process died with non-zero exit; willRestart reflects the policy + backoff decision */
  onCrash?(agent: string, exitCode: number | undefined, willRestart: boolean, delayMs?: number): void;
  /** process exited cleanly (code 0) — informational, never auto-restarted */
  onCleanExit?(agent: string): void;
  /**
   * t-9d76b1 — the process exited because Tachyon asked it to, whatever code it chose to say so with.
   * Never auto-restarted and never announced as a crash: the human already knows, they ordered it.
   */
  onRequestedStop?(agent: string, exitCode: number | undefined): void;
  /** crash-loop guard tripped: too many restarts inside the window */
  onGiveUp?(agent: string, attempts: number): void;
  /** the session vanished (intentional kill or external) — silent in the UI, used by waiters */
  onGone?(agent: string): void;
}

/**
 * Watches session liveness transitions. Crash vs intentional kill is structural:
 * a Tachyon kill removes the whole session (it just disappears), while a process
 * dying on its own leaves a dead pane (remain-on-exit) carrying the exit code.
 *
 * t-9d76b1 — that structure covers a forced Kill and nothing else. A GRACEFUL stop leaves the same
 * dead pane as a crash, because it works by asking the runtime to exit, so the pane cannot tell the
 * two apart and neither can the code it carries. `wasStopRequested` is the third input, and it is the
 * only one that answers "did I ask for this?".
 */
export class LifecycleMonitor {
  private prev = new Map<string, "alive" | "dead">();
  private restartTimes = new Map<string, number[]>();
  /** Agents missing from the last tick's states, awaiting a second consecutive absence
   * before onGone fires (t-3a3a14b) — a single missing observation can be an upstream
   * hiccup rather than an actual kill, and onGone's side effects (waiters.notifyGone,
   * noticeQueue.clear, pokeParentOnDeath) must never run on unconfirmed data. */
  private pendingGone = new Set<string>();

  constructor(
    private readonly io: LifecycleIO,
    private readonly events: LifecycleEvents = {},
  ) {}

  /** Clears the crash-loop history for an agent (manual restart = human took over). */
  resetBackoff(agent: string): void {
    this.restartTimes.delete(agent);
  }

  async tick(): Promise<void> {
    const states = await this.io.agentStates();
    const now = this.io.now();

    for (const [agent, state] of states) {
      this.pendingGone.delete(agent); // seen again — last tick's absence was a blip, not a kill
      const before = this.prev.get(agent);
      const current = state.dead ? "dead" : "alive";
      if (current === "dead" && before !== "dead") {
        // Death observed (including a dead pane discovered on activation).
        //
        // t-9d76b1 — the REQUEST is asked about first, and it decides on its own. Reading the exit code
        // first is what made a stopped grok crash-loop-eligible: 130 is the correct exit of a process
        // that honoured the Ctrl-C Tachyon sent, so `on-crash` would restart the agent the human just
        // stopped, and announce it in red on the way. Codex and pi answer the same Stop with 0 and were
        // never affected — one action, two outcomes, decided by a number that means neither.
        if (this.io.wasStopRequested?.(agent)) {
          this.events.onRequestedStop?.(agent, state.exitCode);
        } else if (state.exitCode === 0) {
          this.events.onCleanExit?.(agent);
        } else {
          this.handleCrash(agent, state.exitCode, now);
        }
      }
      this.prev.set(agent, current);
    }

    // Sessions that vanished were killed intentionally (or externally) — silent in
    // the UI, but waiters blocked on the agent must be released. Require TWO consecutive
    // absent ticks before acting: a single miss can be an upstream hiccup (t-3a3a14) and
    // onGone's side effects (waiter release, notice-queue clear, death poke) are never
    // safe to fire on one unconfirmed observation.
    for (const agent of [...this.prev.keys()]) {
      if (states.has(agent)) continue;
      if (this.pendingGone.has(agent)) {
        this.pendingGone.delete(agent);
        this.prev.delete(agent);
        this.events.onGone?.(agent);
      } else {
        this.pendingGone.add(agent);
      }
    }
  }

  private handleCrash(agent: string, exitCode: number | undefined, now: number): void {
    if (this.io.policyOf(agent) !== "on-crash") {
      this.events.onCrash?.(agent, exitCode, false);
      return;
    }
    const recent = (this.restartTimes.get(agent) ?? []).filter((t) => now - t < RESTART_WINDOW_MS);
    if (recent.length >= RESTART_DELAYS_MS.length) {
      this.restartTimes.set(agent, recent);
      this.events.onGiveUp?.(agent, recent.length);
      return;
    }
    const delay = RESTART_DELAYS_MS[recent.length];
    recent.push(now);
    this.restartTimes.set(agent, recent);
    this.events.onCrash?.(agent, exitCode, true, delay);
    this.io.scheduleRestart(agent, delay);
  }
}
