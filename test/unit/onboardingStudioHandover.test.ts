import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-505f13 round 5 — the studio handover CLOSES the Onboarding tab (owner decision, j-7e9fb17b7dc3):
 * "Open Agent Studio" hands the user to the Studio and onboarding leaves the scene — no
 * confirmation, no delay. The sidebar's own agent-creation path is the normal one afterwards, and
 * whoever reopens Onboarding later still gets the roster-driven refresh from round 2.
 *
 * Source bargain again (the handler lives in the vscode-bound panel host no unit harness
 * instantiates): the guard reads the one branch that owns the behavior. It fails if the branch
 * stops closing — which is exactly the defect shape this card has already paid for once
 * (a method that existed and nothing called).
 *
 * And the round-4 banner exit was SUPERSEDED by this decision — "não construa as duas coisas" —
 * so the guard also pins that the `close` action shape stays out of the contract.
 */

const panel = readFileSync("apps/vscode-extension/src/webview/OnboardingPanel.ts", "utf8");
const messages = readFileSync("packages/webview-ui/src/webview/onboarding/messages.ts", "utf8");
const app = readFileSync("packages/webview-ui/src/webview/onboarding/App.tsx", "utf8");

describe("t-505f13 — Open Agent Studio hands over and the Onboarding tab leaves", () => {
  it("the openAgentStudio branch opens the Studio AND closes the Onboarding panel", () => {
    const branch = /if \(action\.type === "openAgentStudio"\)[^\n]*/.exec(panel)?.[0];
    expect(branch, "openAgentStudio branch not found in OnboardingPanel.ts — did it move?").toBeTruthy();
    expect(branch).toContain("openNewAgentStudio");
    expect(
      branch,
      "the studio handover must CLOSE the onboarding panel in the same gesture — the owner decided the tab leaves the scene on this click",
    ).toMatch(/this\.manager\.close\(session\.target\)/);
  });

  it("the superseded round-4 exit shape stays out: no `close` action, no onb-close button", () => {
    expect(messages).not.toContain('"close"');
    expect(app).not.toContain("onb-close");
  });
});
