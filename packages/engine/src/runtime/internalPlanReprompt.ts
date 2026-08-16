/**
 * t-73885b — fatia 4: when a turn ends `sem-plano` and the project requires
 * a plan for that task kind, reprompt once.
 *
 * Consumes `InternalPlanTurnJudgment`. Does not re-decide the verdict.
 *
 * Who else can reach this:
 *   Tachyon × turn-end (Stop / judge) → considerInternalPlanReprompt
 *   Tachyon × restart / resume / crash-recovery → persisted "already
 *     reprompted", so the second door cannot send a second reprompt
 *   Tachyon × fork → new agent name, one new chance
 *   Interface × edit tachyon.yml → next consider sees the new list
 *   Agent / Bridge → cannot trigger this
 *
 * `sem-canal` and `pending` (including `turn-not-completed`) are not
 * mute. Accusing an agent that could not write a plan, or a turn that
 * never completed, is asserting a state we do not have.
 *
 * Give-up records a journal line and warns. It never blocks delivery.
 */
import { planoRequiresKind } from "../config/planoExigirEm.js";
import type { InternalPlanTurnJudgment } from "./internalPlanTurn.js";

export type InternalPlanRepromptAction = "none" | "reprompt" | "give-up";

export interface InternalPlanRepromptDecision {
  action: InternalPlanRepromptAction;
  prompt?: string;
  journal?: string;
}

export const INTERNAL_PLAN_REPROMPT_TEXT =
  "This task requires an internal plan. The last turn ended without one. Write the plan, then continue. This is the only reminder.";

export const INTERNAL_PLAN_GIVE_UP_JOURNAL =
  "Gave up requiring an internal plan after one reminder. Turn ended without a plan again. Delivery is not blocked.";

export function considerInternalPlanReprompt(input: {
  judgment: InternalPlanTurnJudgment;
  taskKind?: string;
  exigirEm: readonly unknown[] | undefined;
  alreadyReprompted: boolean;
}): InternalPlanRepromptDecision {
  if (input.judgment.state !== "verdict" || input.judgment.verdict !== "sem-plano") {
    return { action: "none" };
  }
  if (!planoRequiresKind(input.exigirEm, input.taskKind)) {
    return { action: "none" };
  }
  if (input.alreadyReprompted) {
    return { action: "give-up", journal: INTERNAL_PLAN_GIVE_UP_JOURNAL };
  }
  return { action: "reprompt", prompt: INTERNAL_PLAN_REPROMPT_TEXT };
}
