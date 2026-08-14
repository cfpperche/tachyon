/**
 * spec 217 — pure state machine behind the background wedge watchdog.
 *
 * `probeServer` only runs at activation + two manual commands, so a tmux server that wedges
 * DURING a live session goes unrecovered until a reload (field incident 2026-06-14). The watchdog
 * runs `probeServer` on a timer and feeds each result here. Because auto-recovery SIGKILLs the
 * server without asking, recovery requires the wedge to persist across TWO consecutive ticks
 * (arm → confirm) — a single transient `wedged` (e.g. a WSL hiccup) that clears next tick never
 * fires. After recovering, it latches until a healthy/no-server probe resets it (one recover per
 * wedge episode). The driver/IO live in extension.ts; this is fully unit-testable.
 */

export type WatchdogState = "idle" | "armed" | "latched";

/**
 * The classification the driver feeds in. `wedged`/`healthy`/`no-server` are the
 * `ServerProbe.state` values; `unknown` is fed when the probe itself THREW (a transient error,
 * not a confirmation either way) — it must NOT count toward the two-tick wedge confirmation.
 */
export type ProbeState = "healthy" | "no-server" | "wedged" | "unknown";

export interface WatchdogStep {
  next: WatchdogState;
  /** "recover" exactly once, on the second consecutive wedged tick. */
  action: "recover" | "none";
}

export function watchdogStep(state: WatchdogState, probe: ProbeState): WatchdogStep {
  if (probe === "wedged") {
    switch (state) {
      case "idle":
        return { next: "armed", action: "none" }; // first wedged tick: arm, don't act yet
      case "armed":
        return { next: "latched", action: "recover" }; // two consecutive: recover once
      case "latched":
        return { next: "latched", action: "none" }; // already recovered; wait for a clear probe
    }
  }
  if (probe === "unknown") {
    // A probe error is not evidence of a wedge — break a pending arm so recovery needs TWO
    // genuinely consecutive wedged ticks. Keep a latch (don't re-arm a server we already killed).
    return { next: state === "armed" ? "idle" : state, action: "none" };
  }
  // healthy | no-server: a definitively-answering (or absent) server clears everything.
  return { next: "idle", action: "none" };
}
