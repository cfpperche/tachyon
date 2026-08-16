/**
 * t-011136 — end-of-turn plan verdict. Not the plan snapshot (`internalPlan.ts`).
 *
 * Three values, closed. A fourth value needs an explicit contract change.
 * Silence is not absence: a verdict is emitted only after the turn has ended.
 * Mid-turn evaluation returns `pending`, never `sem-plano`.
 *
 * `sem-canal` is not mute. Mute (channel existed, nothing came) is `sem-plano`.
 * Accusing an agent that could not write a plan is asserting a state we do not have.
 */
export const INTERNAL_PLAN_VERDICTS = ["com-plano", "sem-plano", "sem-canal"] as const;
export type InternalPlanVerdict = (typeof INTERNAL_PLAN_VERDICTS)[number];

export const INTERNAL_PLAN_TURN_PENDING_REASONS = ["turn-open", "turn-not-completed"] as const;
export type InternalPlanTurnPendingReason = (typeof INTERNAL_PLAN_TURN_PENDING_REASONS)[number];

export type InternalPlanTurnJudgment =
  | { readonly state: "pending"; readonly reason: InternalPlanTurnPendingReason }
  | { readonly state: "verdict"; readonly verdict: InternalPlanVerdict };

export function isInternalPlanVerdict(value: string): value is InternalPlanVerdict {
  return (INTERNAL_PLAN_VERDICTS as readonly string[]).includes(value);
}

/**
 * Shared conjunction after a runtime has closed its own turn window.
 *
 * Priority: a plan event in the window is `com-plano` even if inventory said
 * the channel was absent (we have evidence). A failed/interrupted end is not
 * `sem-plano`. Channel absence is `sem-canal`, not mute.
 */
export function decideInternalPlanTurnVerdict(input: {
  turnEnded: boolean;
  turnCompletedSuccessfully: boolean;
  planEventInWindow: boolean;
  channelPresent: boolean;
}): InternalPlanTurnJudgment {
  if (!input.turnEnded) return { state: "pending", reason: "turn-open" };
  if (input.planEventInWindow) return { state: "verdict", verdict: "com-plano" };
  if (!input.turnCompletedSuccessfully) return { state: "pending", reason: "turn-not-completed" };
  if (!input.channelPresent) return { state: "verdict", verdict: "sem-canal" };
  return { state: "verdict", verdict: "sem-plano" };
}
