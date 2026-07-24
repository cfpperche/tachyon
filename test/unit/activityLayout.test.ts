import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const activityCss = fs.readFileSync(path.join(process.cwd(), "src/webview/activity/activity.css"), "utf8");
const cockpitCss = fs.readFileSync(path.join(process.cwd(), "src/webview/cockpit/cockpit.css"), "utf8");

describe("Activity page layout", () => {
  it("keeps bottom page spacing on the feed without making the document auto-scroll", () => {
    // t-e085bc — the real invariant is body padding 0 (never auto-scroll the shell), not WHICH
    // file provides it. activity.css only ever loads through the cockpit route (the standalone
    // Activity panel was retired, SDD 410 Phase C.2), so cockpit.css — the shell owner, linked
    // last — is the correct and only place to pin it; a redundant bare `body{}` in activity.css
    // was the exact leak class webviewCssScope.test.ts now bans (it survives every co-load
    // forever and would restyle unrelated sections). Assert the guarantee at its real source.
    expect(cockpitCss).toMatch(/(?:html,\s*)?body\s*\{[^}]*padding:\s*0\s*!important/s);
    expect(activityCss).not.toMatch(/(?:^|[};])\s*body\s*\{/s);
    expect(activityCss).toMatch(/\.feed\s*\{[^}]*padding:\s*0 var\(--ds-page-pad-x\) var\(--ds-page-pad-bottom\)/s);
  });
});
