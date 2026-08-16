/**
 * t-73885b — fatia 4: when a turn ends `absent` and the project requires
 * a checklist for that task kind, reprompt once.
 *
 * Consumes `InternalChecklistTurnJudgment`. Does not re-decide the verdict.
 *
 * Who else can reach this:
 *   Tachyon × turn-end (Stop / judge) → considerInternalChecklistReprompt
 *   Tachyon × restart / resume / crash-recovery → persisted "already
 *     reprompted", so the second door cannot send a second reprompt
 *   Tachyon × fork → new agent name, one new chance
 *   Interface × edit tachyon.yml → next consider sees the new list
 *   Agent / Bridge → cannot trigger this
 *
 * `no-channel` and `pending` (including `turn-not-completed`) are not
 * mute. Accusing an agent that could not write a checklist, or a turn that
 * never completed, is asserting a state we do not have.
 *
 * Give-up records a journal line and warns. It never blocks delivery.
 */
import { checklistRequiresKind } from "../config/checklistRequireIn.js";
import type { InternalChecklistTurnJudgment } from "./internalChecklistTurn.js";

export type InternalChecklistRepromptAction = "none" | "reprompt" | "give-up";

export interface InternalChecklistRepromptDecision {
  action: InternalChecklistRepromptAction;
  prompt?: string;
  journal?: string;
}

export const INTERNAL_CHECKLIST_REPROMPT_TEXT =
  "This task requires a checklist. The last turn ended without one. Write the checklist, then continue. This is the only reminder.";

export const INTERNAL_CHECKLIST_GIVE_UP_JOURNAL =
  "Gave up requiring a checklist after one reminder. Turn ended without a checklist again. Delivery is not blocked.";

export function considerInternalChecklistReprompt(input: {
  judgment: InternalChecklistTurnJudgment;
  taskKind?: string;
  requireIn: readonly unknown[] | undefined;
  alreadyReprompted: boolean;
}): InternalChecklistRepromptDecision {
  if (input.judgment.state !== "verdict" || input.judgment.verdict !== "absent") {
    return { action: "none" };
  }
  if (!checklistRequiresKind(input.requireIn, input.taskKind)) {
    return { action: "none" };
  }
  if (input.alreadyReprompted) {
    return { action: "give-up", journal: INTERNAL_CHECKLIST_GIVE_UP_JOURNAL };
  }
  return { action: "reprompt", prompt: INTERNAL_CHECKLIST_REPROMPT_TEXT };
}
