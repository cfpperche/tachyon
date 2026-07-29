import type { AgentInstancePolicy } from "../resume/SessionLedger.js";

/**
 * SDD 482 phase 3 (`t-5e1113`) — the questions readers are actually asking, answered from the
 * DECLARED policy, with one honest legacy path.
 *
 * Readers used to branch on `declared`, which answers "which store owns this definition" and was
 * being read as though it answered "what kind of worker is this". Phase 2 added `instance`
 * ({identity, lifetime}) on the write side. This is where the reading moves.
 *
 * ## Why there is a legacy branch at all, and why it is not synthesis
 *
 * A row written before phase 2 has no `instance`, and phase 2 deliberately refused to invent one at
 * read time — inventing it from `declared` would re-create the inference the split exists to end.
 * So these helpers take the question, not the field:
 *
 *  - if the row DECLARES a policy, the policy answers, full stop;
 *  - if it does not, the answer falls back to `declared`, which is what the reader used before, and
 *    is therefore exactly as right (and exactly as wrong) as it has always been for those rows.
 *
 * The distinction is the whole point. We are not writing a policy value we do not have; we are
 * answering a question the old way for rows that predate the new way. That branch is temporary by
 * construction: it disappears when the last pre-phase-2 row ages out, and `legacyFallbackUsed` makes
 * it observable so the removal can be evidence-based rather than hopeful.
 */
export interface InstancePolicySource {
  /** Storage fact: does config own this definition? Never a policy answer on its own. */
  declared: boolean;
  /** Declared policy, absent on rows written before SDD 482 phase 2. */
  instance?: AgentInstancePolicy;
}

/**
 * True when this instance has no durable Profile behind it — a Temporary Agent.
 *
 * Legacy: `!declared`. That equivalence is exact for every row this build writes, because a declared
 * start writes `saved` and an ad-hoc start writes `temporary`. A FORK is where the two would diverge
 * if `declared` were still the answer, and it is why this function exists: a fork is `temporary`
 * AND `declared: false`, so both agree today — but a fork's LIFETIME is `restartable`, which
 * `declared` alone could never have expressed.
 */
export function isTemporaryInstance(row: InstancePolicySource): boolean {
  if (row.instance) return row.instance.identity === "temporary";
  return !row.declared;
}

/**
 * True when this instance may be started again from its own definition — restart, resume, or an
 * offer to do either.
 *
 * Legacy: `declared`. Note this is where the old conflation was most costly and where the new answer
 * is genuinely BETTER rather than merely equivalent: a fork is not `declared`, yet it owns a resume
 * block and can be resumed. Under `declared` it read as non-restartable; under the declared policy
 * it reads as `restartable`, which is what it has always actually been.
 */
export function mayRestartInstance(row: InstancePolicySource): boolean {
  if (row.instance) return row.instance.lifetime === "restartable";
  return row.declared;
}

/**
 * Whether this instance was given profile-backed lifecycle hooks — persistence hooks, the
 * continuity pointer, and the rest of the declared-agent set.
 *
 * READ, never derived. It would be derivable from `identity` today, and the human's promotion ruling
 * even makes that derivation sound for a running instance — but "sound today" is exactly what
 * `declared` was, and re-deriving it would rebuild the same trap one field over. A promoted agent is
 * the case that makes the distinction real: it has a Saved Profile while its RUNNING instance still
 * carries the ownership-only hooks it launched with.
 *
 * Legacy: `declared`, matching what the reader did before the capability was recorded.
 */
export function hasLifecycleHooks(row: InstancePolicySource): boolean {
  if (row.instance?.lifecycleHooks !== undefined) return row.instance.lifecycleHooks;
  return row.declared;
}

/**
 * Whether the answer came from the legacy path. Exported so the eventual removal of that path is an
 * observation rather than a guess — a workspace whose rows all declare a policy can drop it.
 */
export function legacyFallbackUsed(row: InstancePolicySource): boolean {
  return row.instance === undefined;
}
