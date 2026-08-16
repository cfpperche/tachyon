/**
 * t-281339 — project a sidebar plan line from the fatia-1 snapshot and the
 * fatia-2 verdict. Does not re-read a runtime channel and does not re-judge
 * a turn.
 *
 * Who else can reach this:
 *   Tachyon × fleet refresh → project
 *   Tachyon × spawn / restart / resume / crash-recovery → same projector,
 *     new evidence from the readers/judges
 *   Interface × looks at the sidebar → render only
 *   Agent / Bridge → cannot write this field
 *
 * `sem-canal` is invisible. Accusing an agent that could not write a plan
 * is asserting a state we do not have.
 */
import type { InternalPlanItem, InternalPlanRead } from "../runtime/internalPlan.js";
import type { InternalPlanTurnJudgment } from "../runtime/internalPlanTurn.js";
import type { AgentPlanLine } from "@tachyon/shared/sidebar/types.js";

export function currentPlanStepText(snapshot: InternalPlanRead): string | undefined {
  if (snapshot.state !== "snapshot") return undefined;
  const inProgress = snapshot.items.find((item) => item.status === "in-progress");
  if (inProgress) return inProgress.texto;
  const pending = snapshot.items.find((item) => item.status === "pending");
  return pending?.texto;
}

export function projectAgentPlanLine(
  snapshot: InternalPlanRead,
  judgment: InternalPlanTurnJudgment,
): AgentPlanLine | undefined {
  if (judgment.state === "verdict" && judgment.verdict === "sem-canal") return undefined;

  const step = currentPlanStepText(snapshot);

  if (judgment.state === "pending") {
    return step ? { kind: "step", text: step } : undefined;
  }

  if (judgment.verdict === "sem-plano") return { kind: "sem-plano" };
  return step ? { kind: "step", text: step } : undefined;
}

/** Test helper: a snapshot of the given items. */
export function snapshotOf(items: readonly InternalPlanItem[]): InternalPlanRead {
  return { state: "snapshot", items };
}
