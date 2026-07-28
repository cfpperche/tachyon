/**
 * t-50bbd4 — the consumer the formation lanes never had.
 *
 * SDD 427 built the lanes and SDD 429 built lifecycle/Studio, and the seam between them was never
 * wired: measured, NOTHING in `src/` outside `src/agents/formation/` imported that directory, so a
 * canonical agent's Soul could be authored, transacted and authority-checked — and still never reach
 * a spawn, because `AgentManager` reads `def.soul` and nothing else. Both umbrellas closed. This is
 * the caller each side assumed the other would write.
 *
 * DELIBERATELY NARROW. `AgentManager` takes this port, not the lane modules: one function, one
 * result, no store type, no vector type, no transaction surface. The lifecycle should depend on the
 * lane's CONTRACT rather than on 3652 lines of it, and a port is what keeps a later lane refactor
 * from becoming a spawn-path refactor.
 *
 * FAIL-CLOSED, and this is the part that matters. Soul is identity: rendering the wrong one, or
 * silently rendering none while the operator believes the profile is live, are both worse than
 * refusing. Every failure here is `undefined` plus a stated reason — never a partial or guessed
 * formation. That mirrors the lanes themselves, where `resolveCompleteFormationPayload` fails the
 * whole formation rather than returning a partial payload.
 */

import type { ResolvedSoul } from "../soul.js";

/** Why a canonical agent's Soul did not come from the formation lane. Stated, never inferred. */
export type FormationSoulOutcome =
  /** The lane produced it. */
  | { state: "resolved"; soul: ResolvedSoul }
  /** No formation authority for this agent — it is not a canonical profile agent. Not an error. */
  | { state: "absent" }
  /** There is a vector, but the Soul lane is not in profile mode: the operator chose native delivery. */
  | { state: "lane-disabled" }
  /** The lane refused. Identity is never guessed, so the caller must not fall back to something else. */
  | { state: "refused"; reason: string };

/**
 * Resolve a canonical agent's Soul from its formation authority.
 *
 * Implemented by the host, which is the only place that can hold the suppression key: the receipt
 * attests that the runtime adapter DISABLED native lane delivery first, so Tachyon's rendered Soul is
 * the only one in play. Without that ordering the agent could receive two identities and neither
 * side would know.
 */
export interface FormationLifecyclePort {
  resolveSoul(input: { agentName: string; operationId: string }): Promise<FormationSoulOutcome>;
}

/**
 * Decide which Soul a lifecycle should use, given the declared one and the formation lane.
 *
 * Pure and exported so the precedence is testable without a store, a vector or a spawn — and so the
 * rule lives in one readable place instead of being implied by the order of `if`s at a call site.
 *
 * PRECEDENCE: a declared `def.soul` WINS. That is not an accident of ordering — an inline Soul is an
 * explicit statement in the config the operator is looking at, and having a profile silently override
 * the file in front of them is exactly the confusion this whole area already suffers from. The lane
 * fills the gap the declared path leaves; it does not compete with it.
 */
export function chooseLifecycleSoul(input: {
  declared: ResolvedSoul | undefined;
  formation: FormationSoulOutcome | undefined;
}): { soul: ResolvedSoul | undefined; source: "declared" | "formation" | "none"; refusal?: string } {
  if (input.declared) return { soul: input.declared, source: "declared" };
  const formation = input.formation;
  if (!formation) return { soul: undefined, source: "none" };
  if (formation.state === "resolved") return { soul: formation.soul, source: "formation" };
  if (formation.state === "refused") {
    // Surfaced rather than swallowed: a refusal that reads identically to "this agent has no Soul"
    // is how an operator ends up believing a profile is live when it is not.
    return { soul: undefined, source: "none", refusal: formation.reason };
  }
  return { soul: undefined, source: "none" };
}
