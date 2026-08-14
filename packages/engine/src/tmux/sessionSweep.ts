/**
 * t-2d2ce7 — sweeping a prefix of tmux sessions until it is actually empty.
 *
 * "Stop All" used to enumerate once and kill what it saw. That is a snapshot applied later, and a
 * session born between the enumeration and the kill simply survived — measured: a runbook postmortem
 * pane created by the preceding scenario outlived Stop All by more than ten seconds, and the same run
 * showed it is timing-dependent, because a faster preceding scenario passed.
 *
 * Two rules make the difference, and both matter:
 *
 *  1. SWEEP UNTIL A PASS FINDS NOTHING. One pass proves what existed at the moment it read; only an
 *     empty pass proves there is nothing left. Bounded, so a session that is genuinely being respawned
 *     cannot spin here forever — and when the bound is hit the caller is TOLD, rather than left to
 *     infer success from a function that returned.
 *
 *  2. AN AMBIGUOUS READ IS NOT "NOTHING TO DO". `sessionStates` returns `null` for an error it could
 *     not classify — deliberately distinct from the empty map it returns for a confirmed-absent
 *     server. Both previous callers erased that distinction: the runners coerced it with
 *     `?? new Map()` (kill nothing) and the manager fell back to a possibly stale cache. For a
 *     command whose entire purpose is "stop everything", turning "I could not tell" into "there was
 *     nothing" is the worst available answer — so an ambiguous read is retried, never concluded from.
 *
 * This is the same family as the t-05097f bucket: state captured at T applied at T+n. It is called
 * out because recognising the family is what stops the next one.
 */

/** The slice of TmuxService a sweep needs. Narrow so tests can drive it without a tmux server. */
export interface SessionSweepPort {
  sessionStates(prefix: string): Promise<Map<string, { dead: boolean; exitCode?: number }> | null>;
  killSession(name: string): Promise<void>;
}

export interface SweepResult {
  /** Sessions this sweep killed, in the order they were killed, without duplicates. */
  killed: string[];
  /**
   * True when a read SUCCEEDED and found nothing left. False means the bound was reached with work
   * still outstanding, or every read was ambiguous — either way the caller must not report success.
   */
  converged: boolean;
  /** Passes actually performed, for diagnostics. */
  passes: number;
}

/** Enough to outlast a session being born mid-sweep; small enough that a respawn loop cannot hide here. */
export const DEFAULT_MAX_PASSES = 5;

/**
 * Kill every session under `prefix`, repeating until a successful read finds none.
 *
 * `onKill` lets a caller do its own per-session bookkeeping (transcript detach, lineage cleanup)
 * without reimplementing the loop — the subtlety belongs in one place, not three.
 */
export async function sweepSessions(
  port: SessionSweepPort,
  prefix: string,
  opts: { maxPasses?: number; onKill?: (session: string) => Promise<void> | void } = {},
): Promise<SweepResult> {
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;
  const killed: string[] = [];
  const seen = new Set<string>();
  let converged = false;
  let passes = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    passes = pass + 1;
    const states = await port.sessionStates(prefix);
    if (states === null) {
      // Ambiguous: we do not know what is out there. Try again rather than declare victory over a
      // question we could not read the answer to.
      continue;
    }
    if (states.size === 0) {
      // A read that SUCCEEDED and found nothing. This is the only evidence that the sweep is done.
      converged = true;
      break;
    }
    for (const session of states.keys()) {
      await port.killSession(session);
      if (!seen.has(session)) {
        seen.add(session);
        killed.push(session);
      }
      await opts.onKill?.(session);
    }
  }

  return { killed, converged, passes };
}
