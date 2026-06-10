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
  now(): number;
}

export interface LifecycleEvents {
  /** process died with non-zero exit; willRestart reflects the policy + backoff decision */
  onCrash?(agent: string, exitCode: number | undefined, willRestart: boolean, delayMs?: number): void;
  /** process exited cleanly (code 0) — informational, never auto-restarted */
  onCleanExit?(agent: string): void;
  /** crash-loop guard tripped: too many restarts inside the window */
  onGiveUp?(agent: string, attempts: number): void;
  /** the session vanished (intentional kill or external) — silent in the UI, used by waiters */
  onGone?(agent: string): void;
}

/**
 * Watches session liveness transitions. Crash vs intentional kill is structural:
 * a Tachyon kill removes the whole session (it just disappears), while a process
 * dying on its own leaves a dead pane (remain-on-exit) carrying the exit code.
 */
export class LifecycleMonitor {
  private prev = new Map<string, "alive" | "dead">();
  private restartTimes = new Map<string, number[]>();

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
      const before = this.prev.get(agent);
      const current = state.dead ? "dead" : "alive";
      if (current === "dead" && before !== "dead") {
        // Death observed (including a dead pane discovered on activation).
        if (state.exitCode === 0) {
          this.events.onCleanExit?.(agent);
        } else {
          this.handleCrash(agent, state.exitCode, now);
        }
      }
      this.prev.set(agent, current);
    }

    // Sessions that vanished were killed intentionally (or externally) — silent in
    // the UI, but waiters blocked on the agent must be released.
    for (const agent of [...this.prev.keys()]) {
      if (!states.has(agent)) {
        this.prev.delete(agent);
        this.events.onGone?.(agent);
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
