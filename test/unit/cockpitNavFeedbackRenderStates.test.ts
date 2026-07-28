import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { strings as fixtureStrings } from "../../scripts/webview-preview/fixtures/cockpit.js";

/**
 * t-ac79a7 — the navigation-feedback states, rendered from the real Control shell rather than
 * described.
 *
 * The host half (routePending before the model, routeReady after the content) is proved in
 * cockpitNavPendingBracket.test.ts. This file proves the half a human actually sees: that each
 * phase paints the thing it claims to, and — the assertion that matters most — that the bounded
 * "stalled" phase is a recoverable state with a way out rather than a spinner that never stops.
 *
 * Deliberately asserts on testids and aria state, not on markup shape, so a restyle doesn't break
 * it. The motion itself is a CSS concern (`prefers-reduced-motion` in cockpit.css) and is verified
 * in the headless Visual QA pass, not here — a static serializer cannot observe an animation, and
 * pretending otherwise would be a test that proves nothing.
 */
const SHELL_TSX = path.join(__dirname, "../../src/webview/cockpit/App.tsx");

type NavPhase = "pending" | "slow" | "stalled";

describe("t-ac79a7 — the Control shell's navigation feedback states", () => {
  let Shell: (props: unknown) => unknown;

  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  const render = (navPending?: { routeKey: string; phase: NavPhase }): string =>
    renderStatic(
      Shell({
        strings: fixtureStrings,
        model: undefined,
        navPending,
        onRetryNavigation: () => {},
      }),
    );

  it("shows nothing extra when no navigation is in flight", () => {
    const html = render(undefined);
    expect(html).not.toContain('data-testid="control-nav-progress"');
    expect(html).not.toContain('data-testid="control-nav-stalled"');
    // The live region exists even when idle: a region has to be in the DOM BEFORE its text changes
    // for a screen reader to announce the change at all.
    expect(html).toContain('data-testid="control-nav-status"');
    expect(html).not.toContain('aria-busy="true"');
  });

  it("acknowledges an in-flight navigation immediately, at the first phase", () => {
    const html = render({ routeKey: "task-detail:ws-1:t-000001", phase: "pending" });
    // The complaint this task exists to fix is "nothing happens for seconds". Feedback at phase
    // "pending" — the frame the click commits — is what makes that false.
    expect(html).toContain('data-testid="control-nav-progress"');
    expect(html).toContain('aria-busy="true"');
  });

  it("stays silent to screen readers until a navigation is actually slow", () => {
    const quick = render({ routeKey: "task-detail:ws-1:t-000001", phase: "pending" });
    const slow = render({ routeKey: "task-detail:ws-1:t-000001", phase: "slow" });
    // Announcing every fast route change would make the surface chatty; the visual acknowledgement
    // above is already unconditional, so nothing is lost by waiting to speak.
    expect(quick).not.toContain(fixtureStrings.navLoading);
    expect(slow).toContain(fixtureStrings.navLoading);
  });

  it("ends a stalled navigation in a visible, recoverable state instead of an endless spinner", () => {
    const html = render({ routeKey: "task-detail:ws-1:t-000001", phase: "stalled" });
    expect(html).toContain('data-testid="control-nav-stalled"');
    expect(html).toContain(fixtureStrings.navStalled);
    // The way out has to be reachable, which is the whole difference between "stalled" and "still
    // spinning" — a banner with no action would just be a prettier hang.
    expect(html).toContain(fixtureStrings.navRetry);
    // And the progress bar stops claiming progress nobody can observe any more.
    expect(html).not.toContain('data-testid="control-nav-progress"');
  });

  it("never renders a blank shell in any navigation phase", () => {
    for (const phase of ["pending", "slow", "stalled"] as NavPhase[]) {
      const html = render({ routeKey: "section:fleet", phase });
      // Same invariant cockpitTaskDetailRenderStates.test.ts fixes for the detail view, extended to
      // the states this feature adds: the surface must never go empty (t-2f6cdd's blank tab).
      expect(html, `phase ${phase} rendered the empty shell`).not.toBe('<div class="ds-empty"></div>');
      expect(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), `phase ${phase} rendered no visible text`).not.toBe("");
    }
  });

  it("keeps the route content wrapper keyed so a transition fires per navigation, not per re-render", () => {
    const html = render({ routeKey: "section:fleet", phase: "pending" });
    // The wrapper is what the enter animation is attached to (cockpit.css). It must be present for
    // the transition to exist at all; keying it on the route is what makes the animation replay
    // once per navigation instead of on every poll tick.
    expect(html).toContain("ck-route-content");
  });
});
