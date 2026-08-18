import { describe, expect, it } from "vitest";
import {
  currentChecklistStepText,
  projectAgentChecklistLine,
  snapshotOf,
} from "@tachyon/engine/sidebar/agentChecklistLine.js";
import type { InternalChecklistRead } from "@tachyon/engine/runtime/internalChecklist.js";
import type { InternalChecklistTurnJudgment } from "@tachyon/engine/runtime/internalChecklistTurn.js";

const MUTE: InternalChecklistRead = { state: "mute" };
const PENDING: InternalChecklistTurnJudgment = { state: "pending", reason: "turn-open" };
const COM: InternalChecklistTurnJudgment = { state: "verdict", verdict: "present" };
const ABSENT: InternalChecklistTurnJudgment = { state: "verdict", verdict: "absent" };
const NO_CHANNEL: InternalChecklistTurnJudgment = { state: "verdict", verdict: "no-channel" };

describe("t-281339 — projectAgentChecklistLine", () => {
  it("shows the in-progress step when one is open", () => {
    const snap = snapshotOf([
      { text: "done already", status: "completed" },
      { text: "write the sidebar line", status: "in-progress" },
      { text: "verify at 360", status: "pending" },
    ]);
    expect(currentChecklistStepText(snap)).toBe("write the sidebar line");
    expect(projectAgentChecklistLine(snap, COM)).toEqual({
      kind: "step", text: "write the sidebar line", position: 2, total: 3,
    });
  });

  it("falls through to the next pending when nothing is in-progress", () => {
    const snap = snapshotOf([
      { text: "Boil water", status: "completed" },
      { text: "Steep the tea", status: "pending" },
      { text: "Serve the tea", status: "pending" },
    ]);
    expect(projectAgentChecklistLine(snap, COM)).toEqual({
      kind: "step", text: "Steep the tea", position: 2, total: 3,
    });
  });

  it("numbers the first step from the ordered snapshot", () => {
    const snap = snapshotOf([
      { text: "Start here", status: "in-progress" },
      { text: "Finish later", status: "pending" },
    ]);
    expect(projectAgentChecklistLine(snap, COM)).toEqual({
      kind: "step", text: "Start here", position: 1, total: 2,
    });
  });

  it("numbers the last step from the ordered snapshot", () => {
    const snap = snapshotOf([
      { text: "First", status: "completed" },
      { text: "Second", status: "completed" },
      { text: "Last", status: "pending" },
    ]);
    expect(projectAgentChecklistLine(snap, COM)).toEqual({
      kind: "step", text: "Last", position: 3, total: 3,
    });
  });

  it("occupies no line when every step is completed", () => {
    const snap = snapshotOf([
      { text: "one", status: "completed" },
      { text: "two", status: "completed" },
    ]);
    expect(projectAgentChecklistLine(snap, COM)).toBeUndefined();
  });

  it("marks absent and does not show a leftover snapshot as current work", () => {
    const leftover = snapshotOf([{ text: "yesterday's step", status: "in-progress" }]);
    expect(projectAgentChecklistLine(leftover, ABSENT)).toEqual({ kind: "absent" });
    expect(projectAgentChecklistLine(MUTE, ABSENT)).toEqual({ kind: "absent" });
  });

  it("no-channel is invisible even when a leftover snapshot exists", () => {
    const leftover = snapshotOf([{ text: "a step the agent could not have written", status: "pending" }]);
    expect(projectAgentChecklistLine(leftover, NO_CHANNEL)).toBeUndefined();
    expect(projectAgentChecklistLine(MUTE, NO_CHANNEL)).toBeUndefined();
  });

  it("pending / open turn shows the last known step and never a verdict", () => {
    const snap = snapshotOf([{ text: "still going", status: "in-progress" }]);
    expect(projectAgentChecklistLine(snap, PENDING)).toEqual({
      kind: "step", text: "still going", position: 1, total: 1,
    });
    expect(projectAgentChecklistLine(MUTE, PENDING)).toBeUndefined();
    expect(projectAgentChecklistLine(snap, { state: "pending", reason: "turn-not-completed" })).toEqual({
      kind: "step",
      text: "still going",
      position: 1,
      total: 1,
    });
  });

  it("empty snapshot is not a step", () => {
    expect(projectAgentChecklistLine({ state: "snapshot", items: [] }, COM)).toBeUndefined();
    expect(projectAgentChecklistLine({ state: "snapshot", items: [] }, ABSENT)).toEqual({ kind: "absent" });
  });
});
