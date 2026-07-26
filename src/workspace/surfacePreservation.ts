/**
 * t-b88106 — whether a launch should put an agent's editor surface on screen.
 *
 * The rule, stated once so every lifecycle path shares it: **a relaunch never changes whether an
 * agent is visible.** Starting an agent is a request to look at it; restarting, resuming, or
 * recovering one is not — it continues an agent that was already headless or already open. Before
 * this existed, restart/resume/crash-restart all asserted "reveal", so an agent working headless
 * materialized an editor terminal nobody asked for, interrupting whoever was using the window.
 *
 * Why this needs state at all: exactly one relaunch path destroys the evidence. When restart cannot
 * respawn in place it falls back to kill-session + new-session, and the shell must close the old
 * editor terminal first (it is attached to a session that is about to die). By the time the new
 * process reports itself, "was this agent visible?" is unanswerable — the tab is already gone. So
 * that one path records the answer on its way past, and the next launch consumes it.
 *
 * Every other path can simply ask the presentation, which is why this is a narrow latch rather than a
 * cache of what is open: a second source of truth about visible tabs would drift, and a stale entry
 * claiming an agent was visible is exactly the defect being fixed.
 */

import type { SpawnReveal } from "../agents/AgentManager.js";

export class SurfacePreservation {
  /** agent → was its surface open immediately before a relaunch closed it. */
  private readonly beforeRelaunch = new Map<string, boolean>();

  /**
   * Record an agent's visibility immediately BEFORE a relaunch closes its surface. Call this only
   * from the path that actually closes a surface it intends to bring back — a close that ends the
   * agent should {@link forget} instead, so a dead agent leaves nothing behind to reopen.
   */
  noteBeforeRelaunchClose(agent: string, wasOpen: boolean): void {
    this.beforeRelaunch.set(agent, wasOpen);
  }

  /** The agent is gone (killed, dismissed): drop any pending intent to restore its surface. */
  forget(agent: string): void {
    this.beforeRelaunch.delete(agent);
  }

  /**
   * Resolve a launch's intent against reality. Always consumes the latch — a record that outlived
   * its relaunch (a restart that failed before the new process reported in) must never steer some
   * later, unrelated launch.
   *
   * `isOpenNow` is a thunk because the common case never needs it: `reveal` and `silent` are decided
   * without asking the presentation anything.
   */
  shouldOpen(agent: string, reveal: SpawnReveal, isOpenNow: () => boolean): boolean {
    const wasOpen = this.beforeRelaunch.get(agent);
    this.beforeRelaunch.delete(agent);
    if (reveal === "silent") return false;
    if (reveal === "reveal") return true;
    // preserve — the latch when a relaunch closed the surface, otherwise the live answer (a
    // respawn-in-place restart never closed anything, so the tab is still there to be found).
    return wasOpen ?? isOpenNow();
  }

  /** Test/diagnostic view of the pending latches. */
  pending(): ReadonlyMap<string, boolean> {
    return this.beforeRelaunch;
  }
}
