import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-fullpage-proto — maintainer-directed UX change (2026-07-23): every Control subroute (the 3 Fleet
 * subroutes, all 7 studios and Handoff) replaces the section tab strip with ONE "← Back"
 * row at the very top, instead of showing the full tab strip ABOVE the subroute's own inline
 * back-link. Reviewed and approved via a live headless dev-host before/after comparison (all 6
 * subroute families screenshotted). Same tolerant-source-scan pattern studioCrossStudioResidue.test.ts
 * uses for webview behavior this codebase has no DOM/Preact rendering harness for.
 */
describe("Control subroutes render fullpage chrome (t-fullpage-proto)", () => {
  it("cockpit/App.tsx: the tab strip is swapped for the hoisted breadcrumb when a subroute is active", () => {
    const src = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    // t-ace77f — Project Handoff joined the subroute set when it stopped being a tab.
    // SDD 485 C4 — `task-detail` left this list with the subroute itself: it is a standalone document
    // app, and Control's `navigate` never commits that route (it opens the tab and lands on Overview).
    // SDD 485 D4 — and `inbox-item` left the same way, one migration shape later. It had been the one
    // subroute WITH a nav tab lit under it; that whole arrangement moved INSIDE the Human Inbox app,
    // where the item is a subroute of the app rather than of Control.
    // D17–D19 moved every surviving detail route to its standalone app. With Probes gone there is
    // no Control subroute left to hoist a breadcrumb for; Phase E can remove the dormant CSS next.
    expect(src).not.toContain("const isSubroute =");
    expect(src).not.toContain("isStudioSubroute");
    expect(src).not.toContain("activeRoute?.kind === \"task-detail\"");
    expect(src).not.toContain("activeRoute?.kind === \"inbox-item\"");
    expect(src).not.toContain("let breadcrumb: ComponentChildren = null;");
    expect(src).not.toContain('class="ck-top ck-top--fullpage"');
  });

  it("each surviving branch sets breadcrumb instead of rendering its own inline back-link", () => {
    const src = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    // SDD 485 C4 — the task-detail branch is gone, body and breadcrumb together. Neither the inline
    // wrapper nor the hoisted button may come back: a breadcrumb with nothing to render is a dead path.
    expect(src).not.toContain('<div class="td-breadcrumb"');
    expect(src).not.toContain('data-testid="control-task-detail-breadcrumb"');

    // Fleet subroutes (Activity/Probes) have no Control renderer or breadcrumb branch at all.
    expect(src).not.toMatch(/<ActivityApp[^>]*backLink=/);
    expect(src).not.toMatch(/<ProbesApp[^>]*backLink=/);
    expect(src).not.toContain("control-fleet-subroute-breadcrumb");

    // D13/D20 — studios have no Control renderer or breadcrumb branch at all.
    expect(src).not.toContain("studioMountProps");
    expect(src).not.toContain("control-studio-breadcrumb");

    // SDD 485 D19 — Project Handoff left Control with its renderer and breadcrumb.
    expect(src).not.toContain("control-handoff-breadcrumb");

    // SDD 485 D4 — the inbox-item breadcrumb is gone from HERE, and that is a move rather than a loss:
    // an opened item still goes back to the aggregated list, through the app's own `inbox-item-back`
    // button (`humanInboxApp.test.ts` drives it). A breadcrumb left here would be chrome around a body
    // this file no longer renders.
    expect(src).not.toContain("control-inbox-item-breadcrumb");
  });

  it("task-detail.css: the .td-breadcrumb rule stays removed (its chrome has never come back)", () => {
    const src = readFileSync("src/webview/task-detail/task-detail.css", "utf8");
    expect(src).not.toContain(".td-breadcrumb");
  });

  it("cockpit.css: declares the fullpage chrome classes App.tsx renders", () => {
    const src = readFileSync("src/webview/cockpit/cockpit.css", "utf8");
    expect(src).toContain(".ck-top--fullpage");
    expect(src).toContain(".ck-chrome--fullpage");
    expect(src).toContain(".ck-top-breadcrumb-btn");
  });
});
