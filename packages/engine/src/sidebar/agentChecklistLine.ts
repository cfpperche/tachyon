/**
 * t-281339 — project a sidebar checklist line from the fatia-1 snapshot and the
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
 * `no-channel` is invisible. Accusing an agent that could not write a plan
 * is asserting a state we do not have.
 */
import type { InternalChecklistItem, InternalChecklistRead } from "../runtime/internalChecklist.js";
import type { InternalChecklistTurnJudgment } from "../runtime/internalChecklistTurn.js";
import type { AgentChecklistLine } from "@tachyon/shared/sidebar/types.js";

export function currentChecklistStepText(snapshot: InternalChecklistRead): string | undefined {
  if (snapshot.state !== "snapshot") return undefined;
  const inProgress = snapshot.items.find((item) => item.status === "in-progress");
  if (inProgress) return inProgress.text;
  const pending = snapshot.items.find((item) => item.status === "pending");
  return pending?.text;
}

export function projectAgentChecklistLine(
  snapshot: InternalChecklistRead,
  judgment: InternalChecklistTurnJudgment,
): AgentChecklistLine | undefined {
  if (judgment.state === "verdict" && judgment.verdict === "no-channel") return undefined;

  const step = currentChecklistStepText(snapshot);

  if (judgment.state === "pending") {
    return step ? { kind: "step", text: step } : undefined;
  }

  if (judgment.verdict === "absent") return { kind: "absent" };
  return step ? { kind: "step", text: step } : undefined;
}

/** Test helper: a snapshot of the given items. */
export function snapshotOf(items: readonly InternalChecklistItem[]): InternalChecklistRead {
  return { state: "snapshot", items };
}
