import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.join(process.cwd(), "src/webview/activity/activity.css"), "utf8");

describe("Activity page layout", () => {
  it("keeps bottom page spacing on the feed without making the document auto-scroll", () => {
    expect(css).toMatch(/body\s*\{[^}]*padding:\s*0\s*;/s);
    expect(css).toMatch(/\.feed\s*\{[^}]*padding:\s*0 var\(--ds-page-pad-x\) var\(--ds-page-pad-bottom\)/s);
  });
});
