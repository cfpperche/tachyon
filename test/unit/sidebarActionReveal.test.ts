import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"), "utf8");
const css = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/sidebar.css"), "utf8");

describe("t-91884b — agent overflow trigger is hidden at rest and the ruler aims", () => {
  it("keeps More actions outside the clipped primary-action strip", () => {
    expect(app).toMatch(
      /class=\{`actions\$\{a\.kind === "agent" \? " agent-actions" : ""\}`\}[\s\S]*?a\.kind === "agent" \? \([\s\S]*?<div class="action-reveal">[\s\S]*?primaryActions\(a\)[\s\S]*?<\/div>[\s\S]*?: primaryActions\(a\)\.map[\s\S]*?<MoreBtn/,
    );
  });

  it("does not keep the agent overflow trigger painted at rest", () => {
    expect(css).not.toMatch(/\.row\s*>\s*\.actions\.agent-actions\s*\{[^}]*opacity:\s*1/);
    expect(css).toMatch(/\.row:hover\s*>\s*\.actions\s*,\s*\.row:focus-within\s*>\s*\.actions\s*\{\s*opacity:\s*1/);
    expect(css).toMatch(/\.pin:hover\s+\.actions\s*,\s*\.pin:focus-within\s+\.actions\s*\{\s*opacity:\s*1/);
  });

  it("opens the ruler only when the actions cluster is hovered or focused", () => {
    expect(css).toMatch(
      /\.row\s*>\s*\.actions\.agent-actions:hover\s+\.action-reveal\s*,\s*\.row\s*>\s*\.actions\.agent-actions:focus-within\s+\.action-reveal/,
    );
    expect(css).not.toMatch(/\.row:hover\s*>\s*\.actions\.agent-actions\s+\.action-reveal/);
    expect(css).not.toMatch(/\.row:focus-within\s*>\s*\.actions\.agent-actions\s+\.action-reveal/);
  });

  it("locks trigger visibility to the open overflow menu", () => {
    expect(app).toMatch(/aria-haspopup="menu"\s+aria-expanded=\{expanded\}/);
    expect(app).toMatch(/d\.openMore\(items,\s*e\.clientX,\s*e\.clientY,\s*\(\)\s*=>\s*setExpanded\(false\)\)/);
    expect(css).toMatch(/\.row\s*>\s*\.actions\.agent-actions:has\(\[aria-expanded="true"\]\)\s*\{\s*opacity:\s*1/);
  });

  it("does not insert a transition-delay on the ruler", () => {
    expect(css).not.toMatch(/action-reveal[\s\S]{0,400}transition-delay/);
  });

  it("keeps the 38px agent corridor", () => {
    expect(css).toMatch(/\.row\.agent-card\s*\{\s*--action-gutter:\s*38px\s*;\s*\}/);
  });

  it("removes lateral transitions for reduced motion", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition:\s*none\s*!important/);
  });
});
