import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const activityCss = fs.readFileSync(path.join(process.cwd(), "src/webview/activity/activity.css"), "utf8");
const activityPanel = fs.readFileSync(path.join(process.cwd(), "src/webview/ActivityPanel.ts"), "utf8");

describe("Activity page layout", () => {
  it("keeps bottom page spacing on the feed without making the document auto-scroll", () => {
    // E1 removed Control's global reset. Activity now receives the shared design-system baseline
    // through its own host and keeps its surface stylesheet free of bare document selectors.
    expect(activityPanel).toContain('"design-system.css"');
    expect(activityCss).not.toMatch(/(?:^|[};])\s*body\s*\{/s);
    expect(activityCss).toMatch(/\.feed\s*\{[^}]*padding:\s*0 var\(--ds-page-pad-x\) var\(--ds-page-pad-bottom\)/s);
  });
});
