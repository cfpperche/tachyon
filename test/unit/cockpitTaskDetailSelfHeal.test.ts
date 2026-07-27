import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-2f6cdd — human report: a task flagged `awaiting_human` shows in Attention; clicking `Open`
 * opens a Control tab that renders NOTHING.
 *
 * Measured cause, after eliminating the shell's workspace scope, pre-webview navigation, and route
 * persistence (all three are sound — see the task journal):
 *
 * Every task-detail state renders something visible — `!vm` is "Loading task…", `!vm.task` is
 * "never found on disk", a tombstone is a warning banner. So a blank surface means the client held
 * NO model and NO vm at once, which two guards can produce together:
 *
 *  - the host drops its model post when `navEpoch` moved while it was being built
 *    (Cockpit.ts: `panel === live && navEpoch === epoch`), so the client never learns the route;
 *  - the client then REJECTS the TASK push that follows, because t-9993cc made acceptance
 *    conditional on the active route already matching.
 *
 * t-9993cc's guard is right and stays: it stopped task A's data rendering under task B. What it
 * lacked is a way back — it converted "wrong data" into "no data", with nothing asking again.
 *
 * The fix uses the contract that already existed: `requestSnapshot` (previously reachable only from
 * the manual Refresh button) is now sent once per task identity change, so arrival ORDER stops
 * deciding whether anything renders. Whichever side loses the race, the client asks.
 *
 * Shape note: this codebase has no DOM/Preact harness for client-only webview logic, so this
 * follows the same source-scan convention as its sibling `cockpitTaskDetailIdentity.test.ts` (and
 * `studioCrossStudioResidue.test.ts`, where the convention is documented). It pins the wiring, not
 * the rendering — the runtime proof is the Dev Host Visual QA recorded on the task.
 */

const src = readFileSync("src/webview/cockpit/main.tsx", "utf8");

/** The MODEL branch, where the route is committed and the identity reset happens. */
const modelBranch = src.slice(src.indexOf("const prevTask ="), src.indexOf("setModel(next)"));

describe("t-2f6cdd: a task-detail route asks for its own detail instead of waiting to be pushed", () => {
  it("requests a snapshot when the active route becomes a different task", () => {
    // FAIL-BEFORE: `requestTaskSnapshotAction` was imported but reachable ONLY from the Refresh
    // button's `dispatch.refresh`, so nothing recovered a dropped or rejected push.
    expect(modelBranch).toContain("requestTaskSnapshotAction()");
    expect(modelBranch).toMatch(/post\(requestTaskSnapshotAction\(\)\)/);
  });

  it("asks only on identity change, so a steady stream of models cannot loop", () => {
    // The request must sit behind the SAME condition that clears the stale vm — one ask per task,
    // not one per message. A model push arrives on every refresh tick; an unconditional request
    // here would turn that tick into a request storm.
    expect(modelBranch).toMatch(/taskIdentityChanged\s*&&\s*nextTask/);
    const clearAt = modelBranch.indexOf("setTaskVm(undefined)");
    const askAt = modelBranch.indexOf("post(requestTaskSnapshotAction())");
    expect(clearAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(clearAt);
  });

  it("asks only for a task-detail route — never on the way out of one", () => {
    // `taskIdentityChanged` is also true when LEAVING task-detail (nextTask undefined). Requesting
    // then would ask the host for a detail no route is showing, and the host would answer under a
    // route that has moved on — re-creating the very cross-talk t-9993cc closed.
    expect(modelBranch).toMatch(/taskIdentityChanged\s*&&\s*nextTask\)\s*post\(/);
  });

  it("keeps t-9993cc's guard intact — the request is a way back, not a replacement", () => {
    // If the identity check on receipt were dropped in favour of asking, task A's late push could
    // still land under task B. Both halves are required: reject on receipt, and re-ask on arrival.
    const taskBranch = src.slice(src.indexOf("type === TASK && raw.vm"), src.indexOf("type === ACTIVITY && raw.vm"));
    expect(taskBranch).toMatch(/route\?\.kind === "task-detail"/);
    expect(taskBranch).toMatch(/route\.wsHash === vm\.wsHash/);
    expect(taskBranch).toMatch(/route\.taskId === vm\.id/);
  });
});
