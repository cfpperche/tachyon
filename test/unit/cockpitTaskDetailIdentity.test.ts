import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-9993cc — maintainer report: Board → click a task navigates but Task Detail sometimes renders
 * blank, no error. cockpit/main.tsx's client-side `onMsg` handler (this codebase has no DOM/Preact
 * rendering harness for client-only webview logic — see studioCrossStudioResidue.test.ts's doc
 * comment for the established source-scan-shape convention this test follows) had two gaps in how it
 * handled TASK messages, unlike its ACTIVITY sibling which already guards both:
 *
 * 1. No identity check on receipt — `type === TASK && raw.vm` set `taskVm` unconditionally, so a
 *    delayed/out-of-order TASK push from a route already navigated away from could repopulate
 *    taskVm under the WRONG (or no) task-detail route.
 * 2. No reset on navigation — nothing cleared `taskVm` when `activeRoute` changed to a DIFFERENT
 *    task (or away from task-detail entirely), unlike ACTIVITY's explicit `setActivityVm(undefined)`
 *    on identity change. A fast double-click between two Board cards could show task A's data under
 *    task B's route.
 */

describe("t-9993cc: cockpit/main.tsx's TASK message handling matches ACTIVITY's identity-safety pattern", () => {
  const src = readFileSync("src/webview/cockpit/main.tsx", "utf8");

  it("resets taskVm on task-detail identity change, mirroring the activity reset", () => {
    expect(src).toMatch(/prevTask\.wsHash\s*!==\s*nextTask\.wsHash\s*\|\|\s*prevTask\.taskId\s*!==\s*nextTask\.taskId/);
    expect(src).toContain("setTaskVm(undefined)");
    // must happen in the SAME synchronous MODEL-message branch as the model commit, same reasoning
    // as the studioIncoming clear this pattern is modeled on (an effect-based clear runs too late).
    const clearAt = src.indexOf("setTaskVm(undefined)");
    const setModelAt = src.indexOf("setModel(next)");
    expect(clearAt).toBeGreaterThan(-1);
    expect(setModelAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(setModelAt);
  });

  it("only accepts a TASK message whose wsHash+id match the CURRENTLY active task-detail route", () => {
    const taskBranch = src.slice(src.indexOf("type === TASK && raw.vm"), src.indexOf("type === ACTIVITY && raw.vm"));
    expect(taskBranch).toMatch(/route\?\.kind === "task-detail"/);
    expect(taskBranch).toMatch(/route\.wsHash === vm\.wsHash/);
    expect(taskBranch).toMatch(/route\.taskId === vm\.id/);
    // the accept must be conditional (inside the identity check), not unconditional.
    expect(taskBranch).toMatch(/if\s*\([^)]*\)\s*{\s*setTaskVm\(vm\);/);
  });
});
