import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetVscodeMock } from "../mocks/vscode.js";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { onboardingFixtures } from "../../scripts/webview-preview/fixtures/onboarding.js";
import type { OnboardingAction, OnboardingModel } from "@tachyon/webview-ui/webview/onboarding/messages";

/**
 * t-505f13 — what the Onboarding app puts on screen, rendered from the SAME fixtures the preview
 * harness serves (one source of intent, both doors). The claims asserted are the card's DONE_WHEN:
 * the environment row that is missing is named with its remedy, bootstrap is offered only when the
 * environment can run an agent, and a fully set-up machine collapses to "You're set up" instead of
 * a tour the experienced user has to dismiss.
 */

const repoRoot = path.resolve(__dirname, "../..");

const fixture = (name: string): OnboardingModel =>
  (onboardingFixtures[name]!.vm as OnboardingModel);

describe("the Onboarding app screen", () => {
  let App: (props: { model?: OnboardingModel; dispatch: (a: OnboardingAction) => void }) => unknown;
  const posted: OnboardingAction[] = [];
  const render = (model?: OnboardingModel): string => renderStatic(App({ model, dispatch: (a) => posted.push(a) }));

  beforeEach(async () => {
    __resetVscodeMock();
    posted.length = 0;
    const mod = await loadWebviewModule(path.join(repoRoot, "packages/webview-ui/src/webview/onboarding/App.tsx"));
    App = mod.App as typeof App;
  });

  it("renders a loading state, claiming nothing, before the host answers", () => {
    const html = render(undefined);
    expect(html).toContain("Checking this machine");
    expect(html).not.toContain('data-testid="onb-step-environment"');
  });

  it("a fresh workspace: environment done, workspace current, bootstrap offered", () => {
    const html = render(fixture("fresh"));
    expect(html).toContain('data-state="done" data-testid="onb-step-environment"');
    expect(html).toContain('data-state="current" data-testid="onb-step-workspace"');
    expect(html).toContain('data-state="waiting" data-testid="onb-step-agent"');
    expect(html).toContain('data-testid="onb-initialize"');
  });

  it("a missing agent CLI is named on screen with its remedy — and blocks the bootstrap offer", () => {
    const html = render(fixture("missing-cli"));
    expect(html).toContain('data-testid="onb-env-agent-cli"');
    expect(html).toContain("no attested agent CLI on PATH");
    expect(html).toContain("Install one of");
    // The card's point: the requirement that fails silently today must not offer a bootstrap that
    // would produce a workspace no agent can ever run in.
    expect(html).toContain('data-testid="onb-initialize" disabled');
  });

  it("an honest 'later' for credentials before any agent declares one", () => {
    const html = render(fixture("missing-cli"));
    expect(html).toContain('data-testid="onb-env-credential"');
    expect(html).toContain("checked when your first agent declares one");
    expect(html).not.toContain('data-testid="onb-open-keys"');
  });

  it("a set-up machine collapses to the all-set banner — no tour, no steps left dangling", () => {
    const html = render(fixture("all-set"));
    expect(html).toContain('data-testid="onb-allset"');
    expect(html).toContain('data-state="done" data-testid="onb-step-agent"');
  });

  it("post-bootstrap with no agent yet: step 3 is current and Agent Studio is the door", () => {
    const html = render(fixture("first-agent"));
    expect(html).toContain('data-state="current" data-testid="onb-step-agent"');
    expect(html).toContain('data-testid="onb-agent-ready"');
    expect(html).toContain('data-testid="onb-open-studio"');
    expect(html).not.toContain('data-testid="onb-allset"');
  });

  /**
   * t-505f13 round 4 — the finished state OFFERS ITS OWN EXIT. The owner's finding: the screen had a
   * beginning and a middle and no end — "You're set up" rendered and the tab stayed open forever,
   * with nothing telling the user the task was over or how to leave. The exit is a USER action in
   * the banner (never automatic — a tab that vanishes alone is worse than one that stays), and a
   * mid-flow screen must NOT offer it: "Close this tab" next to a pending step would read as done.
   */
  it("the allSet banner offers an explicit exit, and only the allSet state does", () => {
    const done = render(fixture("all-set"));
    expect(done).toContain('data-testid="onb-allset"');
    expect(done).toContain('data-testid="onb-close"');
    expect(done).toContain("Close this tab");
    const fresh = render(fixture("fresh"));
    expect(fresh).not.toContain('data-testid="onb-close"');
    const firstAgent = render(fixture("first-agent"));
    expect(firstAgent).not.toContain('data-testid="onb-close"');
  });

  it("exposes the re-check door in every state and the config door once a config exists", () => {
    // The button CLICKS are driven in the preview harness (a browser, real handlers); here the
    // claim is the doors are on screen in the states that own them.
    const fresh = render(fixture("fresh"));
    expect(fresh).toContain('data-testid="onb-recheck"');
    expect(fresh).not.toContain('data-testid="onb-open-config"');
    const allSet = render(fixture("all-set"));
    expect(allSet).toContain('data-testid="onb-recheck"');
    expect(allSet).toContain('data-testid="onb-open-config"');
  });
});
