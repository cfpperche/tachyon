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

export function currentChecklistStep(snapshot: InternalChecklistRead):
  | { text: string; position: number; total: number }
  | undefined {
  if (snapshot.state !== "snapshot") return undefined;
  const index = snapshot.items.findIndex((item) => item.status === "in-progress");
  const currentIndex = index >= 0
    ? index
    : snapshot.items.findIndex((item) => item.status === "pending");
  // Keep a completed plan visible as `(n/n)`. A snapshot is still useful after
  // the turn closes: disappearing the line made a finished checklist
  // indistinguishable from one that had never been recorded.
  const completedIndex = currentIndex < 0 && snapshot.items.every((item) => item.status === "completed")
    ? snapshot.items.length - 1
    : currentIndex;
  if (completedIndex < 0) return undefined;
  return {
    text: snapshot.items[completedIndex]!.text,
    position: completedIndex + 1,
    total: snapshot.items.length,
  };
}

export function currentChecklistStepText(snapshot: InternalChecklistRead): string | undefined {
  return currentChecklistStep(snapshot)?.text;
}

export function projectAgentChecklistLine(
  snapshot: InternalChecklistRead,
  judgment: InternalChecklistTurnJudgment,
): AgentChecklistLine | undefined {
  if (judgment.state === "verdict" && judgment.verdict === "no-channel") return undefined;

  const step = currentChecklistStep(snapshot);

  if (judgment.state === "pending") {
    return step ? { kind: "step", ...step } : undefined;
  }

  if (judgment.verdict === "absent") return { kind: "absent" };
  return step ? { kind: "step", ...step } : undefined;
}

/** Test helper: a snapshot of the given items. */
export function snapshotOf(items: readonly InternalChecklistItem[]): InternalChecklistRead {
  return { state: "snapshot", items };
}
