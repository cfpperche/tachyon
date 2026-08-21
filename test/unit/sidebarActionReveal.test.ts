import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"), "utf8");
const css = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/sidebar.css"), "utf8");

describe("t-83bcf4 — agent row actions reveal from the overflow trigger", () => {
  it("keeps More actions outside the clipped primary-action strip", () => {
    expect(app).toMatch(
      /class=\{`actions\$\{a\.kind === "agent" \? " agent-actions" : ""\}`\}[\s\S]*?a\.kind === "agent" \? \([\s\S]*?<div class="action-reveal">[\s\S]*?primaryActions\(a\)[\s\S]*?<\/div>[\s\S]*?: primaryActions\(a\)\.map[\s\S]*?<MoreBtn/,
    );
  });

  it("reveals agent actions for hover and keyboard focus without changing pins", () => {
    expect(css).toMatch(/\.row\s*>\s*\.actions\.agent-actions\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.row:hover\s*>\s*\.actions\.agent-actions\s+\.action-reveal\s*,\s*\.row:focus-within\s*>\s*\.actions\.agent-actions\s+\.action-reveal/);
    expect(css).toMatch(/\.pin:hover\s+\.actions\s*,\s*\.pin:focus-within\s+\.actions\s*\{\s*opacity:\s*1/);
  });

  it("removes lateral transitions for reduced motion", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition:\s*none\s*!important/);
  });
});
