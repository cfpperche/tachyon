import type { AgentInstancePolicy } from "../resume/SessionLedger.js";

/**
 * t-04052d — the questions readers actually ask, answered from the DECLARED policy and from nothing
 * else.
 *
 * ## What changed, and why there is no fallback any more
 *
 * These helpers used to have a second answer: if a row declared no policy, they fell back to
 * `declared` — the storage fact "config owns this definition" — because that is what readers used
 * before SDD 482 phase 2 existed. That fallback was correct for its moment and is now removed with
 * the field itself. `lifetime` is the only property that answers durability of the definition, so
 * there is no longer a second source to consult, honest or otherwise.
 *
 * ## What a policy-less row means now
 *
 * It means the row predates the cut, and this build does not know what it is. The three helpers below
 * FAIL CLOSED on that shape rather than guessing: not restartable, no lifecycle hooks, and treated as
 * temporary — the reading that withholds capability instead of granting it. That is deliberately the
 * conservative direction, because every consequence of being wrong is then a refusal an operator can
 * see, not a restart of something this build cannot describe.
 *
 * In an ACTIVATED workspace the branch is unreachable by construction: `inspectLegacyFleet` refuses to
 * activate while any ledger row lacks a policy (`legacyFallbackUsed` is that exact check), so a row
 * reaching these helpers has declared one. The fail-closed answers exist for the paths that read the
 * ledger before or around that gate, not as a compatibility mode.
 */
export interface InstancePolicySource {
  /** Declared policy. Absent only on a row written before the cut, which the activation gate refuses. */
  instance?: AgentInstancePolicy;
}

/**
 * True when this instance has no durable Profile behind it — a Temporary Agent.
 *
 * A FORK is the case that proves this must be its own axis: a fork is `temporary` AND `restartable`,
 * so the answer here says nothing about whether it may be started again. Ask `mayRestartInstance` for
 * that, and never infer one from the other.
 */
export function isTemporaryInstance(row: InstancePolicySource): boolean {
  return row.instance?.lifetime !== "saved";
}

/**
 * True when this instance may be started again from its own definition — restart, resume, or an
 * offer to do either.
 */
export function mayRestartInstance(row: InstancePolicySource): boolean {
  return row.instance?.resumePolicy === "restartable";
}

/**
 * Whether this instance was given profile-backed lifecycle hooks — persistence hooks, the
 * continuity pointer, and the rest of the profile-backed set.
 *
 * READ, never derived. It would be derivable from `lifetime` today, and the human's promotion ruling
 * even makes that derivation sound for a running instance — but "sound today" is exactly what
 * `declared` was, and re-deriving it would rebuild the same trap one field over. A promoted agent is
 * the case that makes the distinction real: it has a Saved Profile while its RUNNING instance still
 * carries the ownership-only hooks it launched with.
 */
export function hasLifecycleHooks(row: InstancePolicySource): boolean {
  return row.instance?.lifecycleHooks === true;
}

/**
 * Whether this row predates the cut and therefore declares no policy at all.
 *
 * This is what the activation gate refuses on (`inspectLegacyFleet`, check 1). It is the observation
 * the legacy path was instrumented to produce, now cashed in as an admission rule rather than a
 * branch: the answer is no longer "read it the old way", it is "do not activate".
 */
export function legacyFallbackUsed(row: InstancePolicySource): boolean {
  return row.instance === undefined;
}
