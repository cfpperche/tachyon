import { describe, expect, it } from "vitest";
import {
  currentPlanStepText,
  projectAgentPlanLine,
  snapshotOf,
} from "@tachyon/engine/sidebar/agentPlanLine.js";
import type { InternalPlanRead } from "@tachyon/engine/runtime/internalPlan.js";
import type { InternalPlanTurnJudgment } from "@tachyon/engine/runtime/internalPlanTurn.js";

const MUTE: InternalPlanRead = { state: "mute" };
const PENDING: InternalPlanTurnJudgment = { state: "pending", reason: "turn-open" };
const COM: InternalPlanTurnJudgment = { state: "verdict", verdict: "com-plano" };
const SEM_PLANO: InternalPlanTurnJudgment = { state: "verdict", verdict: "sem-plano" };
const SEM_CANAL: InternalPlanTurnJudgment = { state: "verdict", verdict: "sem-canal" };

describe("t-281339 — projectAgentPlanLine", () => {
  it("shows the in-progress step when one is open", () => {
    const snap = snapshotOf([
      { texto: "done already", status: "completed" },
      { texto: "write the sidebar line", status: "in-progress" },
      { texto: "verify at 360", status: "pending" },
    ]);
    expect(currentPlanStepText(snap)).toBe("write the sidebar line");
    expect(projectAgentPlanLine(snap, COM)).toEqual({ kind: "step", text: "write the sidebar line" });
  });

  it("falls through to the next pending when nothing is in-progress", () => {
    const snap = snapshotOf([
      { texto: "Boil water", status: "completed" },
      { texto: "Steep the tea", status: "pending" },
      { texto: "Serve the tea", status: "pending" },
    ]);
    expect(projectAgentPlanLine(snap, COM)).toEqual({ kind: "step", text: "Steep the tea" });
  });

  it("occupies no line when every step is completed", () => {
    const snap = snapshotOf([
      { texto: "one", status: "completed" },
      { texto: "two", status: "completed" },
    ]);
    expect(projectAgentPlanLine(snap, COM)).toBeUndefined();
  });

  it("marks sem-plano and does not show a leftover snapshot as current work", () => {
    const leftover = snapshotOf([{ texto: "yesterday's step", status: "in-progress" }]);
    expect(projectAgentPlanLine(leftover, SEM_PLANO)).toEqual({ kind: "sem-plano" });
    expect(projectAgentPlanLine(MUTE, SEM_PLANO)).toEqual({ kind: "sem-plano" });
  });

  it("sem-canal is invisible even when a leftover snapshot exists", () => {
    const leftover = snapshotOf([{ texto: "a step the agent could not have written", status: "pending" }]);
    expect(projectAgentPlanLine(leftover, SEM_CANAL)).toBeUndefined();
    expect(projectAgentPlanLine(MUTE, SEM_CANAL)).toBeUndefined();
  });

  it("pending / open turn shows the last known step and never a verdict", () => {
    const snap = snapshotOf([{ texto: "still going", status: "in-progress" }]);
    expect(projectAgentPlanLine(snap, PENDING)).toEqual({ kind: "step", text: "still going" });
    expect(projectAgentPlanLine(MUTE, PENDING)).toBeUndefined();
    expect(projectAgentPlanLine(snap, { state: "pending", reason: "turn-not-completed" })).toEqual({
      kind: "step",
      text: "still going",
    });
  });

  it("empty snapshot is not a step", () => {
    expect(projectAgentPlanLine({ state: "snapshot", items: [] }, COM)).toBeUndefined();
    expect(projectAgentPlanLine({ state: "snapshot", items: [] }, SEM_PLANO)).toEqual({ kind: "sem-plano" });
  });
});
