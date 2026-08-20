import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-505f13 (devhost validation) — the roster-change door must reach the Onboarding panel.
 *
 * The defect, measured by the owner on 781f0c52: `OnboardingPanelManager.refresh()` existed and
 * NOTHING called it, so after creating the first agent in Agent Studio the onboarding tab kept step 3
 * pending forever — the user had to press Re-check by hand. "A part nothing reaches is not
 * delivered", except this time the unreachable part was a method that shipped green.
 *
 * The mechanism this pins (all of it already tested in SectionPanelManager's own suite): the engine
 * emits `views-changed: agents` when the roster changes → `onViewsChanged` fans out → a VISIBLE
 * panel replays `send()` (fresh agentCount, step 3 closes live) and a HIDDEN panel journals the
 * refresh and rebuilds on reveal (step 3 closes when the user comes back). No polling anywhere.
 *
 * The bargain is the house's source-text one (studioCutoverRouting, webviewAppBudget/esbuild parity):
 * the wiring lives inside extension.ts's activate(), which no unit harness can instantiate, so the
 * guard reads the one call site and fails the day someone deletes the line — which is precisely how
 * the defect arrived.
 */

const source = readFileSync("apps/vscode-extension/src/extension.ts", "utf8");

function onViewsChangedBody(): string {
  const start = source.indexOf("const onViewsChanged = ");
  expect(start, "onViewsChanged not found in extension.ts — did it move or get renamed?").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n  };", start);
  return source.slice(start, end);
}

describe("t-505f13 — the roster-change event reaches the Onboarding panel", () => {
  it("onViewsChanged fans out to onboardingPanels.refresh()", () => {
    const body = onViewsChangedBody();
    expect(body, "the fan-out must call onboardingPanels.refresh() — without it, step 3 of the onboarding screen never closes after the first agent is created (owner validation, devhost)").toContain("onboardingPanels.refresh()");
  });

  it("the fan-out is the AGENTS branch — roster change is the event that owns this refresh", () => {
    const body = onViewsChangedBody();
    // The exact wiring shape: a single-statement agents branch. There is more than one
    // `view === "agents"` line in the fan-out, so a loose containment could pass on the wrong one.
    expect(body).toMatch(/if \(view === "agents"\) onboardingPanels\.refresh\(\);/);
  });

  it("the panel still exposes the door being wired (refresh delegates to the section manager)", () => {
    const panel = readFileSync("apps/vscode-extension/src/webview/OnboardingPanel.ts", "utf8");
    expect(panel).toMatch(/refresh\(\): void \{[^}]*this\.manager\.refresh\("onboarding"\)/);
  });
});
