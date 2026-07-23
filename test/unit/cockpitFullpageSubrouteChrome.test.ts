import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-fullpage-proto — maintainer-directed UX change (2026-07-23): every Control subroute (task-detail,
 * the 3 Fleet subroutes, and all 7 studios) replaces the section tab strip with ONE minimal "← Back"
 * row at the very top, instead of showing the full tab strip ABOVE the subroute's own inline
 * back-link. Reviewed and approved via a live headless dev-host before/after comparison (all 6
 * subroute families screenshotted). Same tolerant-source-scan pattern studioCrossStudioResidue.test.ts
 * uses for webview behavior this codebase has no DOM/Preact rendering harness for.
 */
describe("Control subroutes render fullpage chrome (t-fullpage-proto)", () => {
  it("cockpit/App.tsx: the tab strip is swapped for the hoisted breadcrumb when a subroute is active", () => {
    const src = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    expect(src).toContain("const isSubroute = activeRoute?.kind === \"task-detail\" || isFleetSubroute || isStudioSubroute;");
    expect(src).toContain("let breadcrumb: ComponentChildren = null;");
    expect(src).toMatch(/isSubroute && breadcrumb \? \(\s*<header class="ck-top ck-top--fullpage">/);
    expect(src).toContain('<div class="ck-chrome ck-chrome--fullpage">{breadcrumb}</div>');
  });

  it("each of the 3 branches sets breadcrumb instead of rendering its own inline back-link", () => {
    const src = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    // task-detail: no more inline .td-breadcrumb wrapper in the body.
    expect(src).not.toContain('<div class="td-breadcrumb"');
    expect(src).toMatch(/breadcrumb = \(\s*<Button variant="default" icon="arrow-left" class="ck-top-breadcrumb-btn" data-testid="control-task-detail-breadcrumb"/);

    // Fleet subroutes (Activity/Probes): backLink prop no longer passed to either component.
    expect(src).not.toMatch(/<ActivityApp[^>]*backLink=/);
    expect(src).not.toMatch(/<ProbesApp[^>]*backLink=/);
    expect(src).toMatch(/breadcrumb = \(\s*<Button variant="default" icon="arrow-left" class="ck-top-breadcrumb-btn" data-testid="control-fleet-subroute-breadcrumb"/);

    // studios: backLink no longer threaded into studioMountProps.
    expect(src).not.toMatch(/studioMountProps = \{[^}]*backLink/);
    expect(src).toContain('breadcrumb = activeRoute.studio === "pin" ? (');
  });

  it("task-detail.css: the now-unreachable .td-breadcrumb rule was removed, not left dead", () => {
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
