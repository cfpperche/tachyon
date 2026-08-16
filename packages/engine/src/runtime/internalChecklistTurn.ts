/**
 * t-011136 — end-of-turn plan verdict. Not the plan snapshot (`internalChecklist.ts`).
 *
 * Three values, closed. A fourth value needs an explicit contract change.
 * Silence is not absence: a verdict is emitted only after the turn has ended.
 * Mid-turn evaluation returns `pending`, never `absent`.
 *
 * `no-channel` is not mute. Mute (channel existed, nothing came) is `absent`.
 * Accusing an agent that could not write a plan is asserting a state we do not have.
 */
export const INTERNAL_CHECKLIST_VERDICTS = ["present", "absent", "no-channel"] as const;
export type InternalChecklistVerdict = (typeof INTERNAL_CHECKLIST_VERDICTS)[number];

export const INTERNAL_CHECKLIST_TURN_PENDING_REASONS = ["turn-open", "turn-not-completed"] as const;
export type InternalChecklistTurnPendingReason = (typeof INTERNAL_CHECKLIST_TURN_PENDING_REASONS)[number];

export type InternalChecklistTurnJudgment =
  | { readonly state: "pending"; readonly reason: InternalChecklistTurnPendingReason }
  | { readonly state: "verdict"; readonly verdict: InternalChecklistVerdict };

export function isInternalChecklistVerdict(value: string): value is InternalChecklistVerdict {
  return (INTERNAL_CHECKLIST_VERDICTS as readonly string[]).includes(value);
}

/**
 * Shared conjunction after a runtime has closed its own turn window.
 *
 * Priority: a plan event in the window is `present` even if inventory said
 * the channel was absent (we have evidence). A failed/interrupted end is not
 * `absent`. Channel absence is `no-channel`, not mute.
 */
export function decideInternalChecklistTurnVerdict(input: {
  turnEnded: boolean;
  turnCompletedSuccessfully: boolean;
  checklistEventInWindow: boolean;
  channelPresent: boolean;
}): InternalChecklistTurnJudgment {
  if (!input.turnEnded) return { state: "pending", reason: "turn-open" };
  if (input.checklistEventInWindow) return { state: "verdict", verdict: "present" };
  if (!input.turnCompletedSuccessfully) return { state: "pending", reason: "turn-not-completed" };
  if (!input.channelPresent) return { state: "verdict", verdict: "no-channel" };
  return { state: "verdict", verdict: "absent" };
}
