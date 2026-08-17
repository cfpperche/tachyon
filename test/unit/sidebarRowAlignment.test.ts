import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// t-b8ff2c — level-0 agent rows must share one left column whether or not they have children. Root
// cause: the disclosure-toggle gutter (.agent-toggle) was rendered ONLY when hasChildren, so a childless
// row's sdot/name sat ~21px left of a row with a toggle. The fix reserves the same-sized gutter on every
// row: a real toggle button when hasChildren, an equally-sized spacer when not.

const appTsxPath = path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx");
const cssPath = path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/sidebar.css");
const appTsx = readFileSync(appTsxPath, "utf8");
const css = readFileSync(cssPath, "utf8");

/** Cascade-order (last-wins) declarations for every rule whose selector LIST contains `selector`
 *  (exact, comma-split match) — e.g. `declarationsFor(css, ".agent-toggle-spacer")` also picks up a
 *  combined `.agent-toggle, .agent-toggle-spacer { ... }` rule. */
/** Fallback px of `--ds-spacing-size*` (tokens.css). t-9c7ce8 moved rhythm onto those names. */
const SPACING_PX: Record<string, number> = {
  "--ds-spacing-size20": 2,
  "--ds-spacing-size40": 4,
  "--ds-spacing-size60": 6,
  "--ds-spacing-size80": 8,
  "--ds-spacing-size100": 10,
  "--ds-spacing-size120": 12,
  "--ds-spacing-size160": 16,
  "--ds-spacing-size200": 20,
  "--ds-spacing-size240": 24,
  "--ds-spacing-size320": 32,
};

/** t-d588c3 — name-column geometry on `.row`. Same computed px as the old 28/13/72 literals. */
const GEOMETRY_PX: Record<string, number> = {
  "--sidebar-name-col": 28,
  "--sidebar-child-name-col": 13,
  "--sidebar-focus-trail": 72,
};

/** First length in a CSS value: `12px`, `var(--ds-spacing-size120)`, or a shorthand component. */
function px(value: string | undefined, index = 0): number {
  const part = (value ?? "").trim().split(/\s+/)[index] ?? "";
  const token = /var\(\s*(--(?:ds-spacing-size\d+|sidebar-[\w-]+))/.exec(part)?.[1];
  if (token && token in SPACING_PX) return SPACING_PX[token];
  if (token && token in GEOMETRY_PX) return GEOMETRY_PX[token];
  const n = parseInt(part, 10);
  return n;
}

function declarationsFor(source: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(noComments))) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of m[2].split(";")) {
      const [prop, ...rest] = decl.split(":");
      if (!prop || !rest.length) continue;
      out[prop.trim()] = rest.join(":").trim();
    }
  }
  return out;
}

describe("sidebar row alignment (t-b8ff2c)", () => {
  it("reserves the disclosure gutter for a childless top-level row", () => {
    // AgentRow renders the toggle button only when hasChildren, and an equally-sized spacer otherwise —
    // never omitting the gutter outright.
    expect(appTsx).toMatch(/hasChildren\s*\?[\s\S]{0,900}agent-toggle-spacer/);

    const toggle = declarationsFor(css, ".agent-toggle");
    const spacer = declarationsFor(css, ".agent-toggle-spacer");
    expect(Object.keys(spacer).length).toBeGreaterThan(0);

    // The spacer must occupy IDENTICAL box space to the real toggle — same width/height/margin — or a
    // childless row's sdot/name will drift out of alignment with a row that has one.
    expect(spacer.width).toBe(toggle.width);
    expect(spacer.height).toBe(toggle.height);
    expect(spacer.margin).toBe(toggle.margin);
  });

  it("indents a child row clearly deeper than the aligned level-0 column", () => {
    const row = declarationsFor(css, ".row");
    const child = declarationsFor(css, ".row.child");
    const gutter = declarationsFor(css, ".agent-toggle");
    const rowTop = declarationsFor(css, ".row-top");

    const rowPadding = px(row.padding, 1);
    const gutterWidth = px(gutter.width);
    const rowTopGap = px(rowTop.gap);
    const level0SdotX = rowPadding + gutterWidth + rowTopGap;

    const childPaddingLeft = px(child["padding-left"]);
    const childSdotX = childPaddingLeft + gutterWidth + rowTopGap;

    expect(childSdotX).toBeGreaterThan(level0SdotX);
  });

  it("aligns child meta/focus under the child name (no parent toggle gutter)", () => {
    // Parent rows reserve .agent-toggle / spacer; nested rows do not. Meta/focus pad must match
    // the visible name column for each case — not reuse the parent 28px on children.
    const meta = declarationsFor(css, ".row-meta");
    const focus = declarationsFor(css, ".row-focus");
    const childMeta = declarationsFor(css, ".row.child .row-meta");
    const childFocus = declarationsFor(css, ".row.child .row-focus");

    expect(px(meta["padding-left"])).toBeGreaterThan(20);
    expect(px(focus["padding-left"] ?? focus.padding, 3)).toBeGreaterThan(20);

    const childMetaPad = px(childMeta["padding-left"]);
    const childFocusPad = px(childFocus["padding-left"]);
    expect(childMetaPad).toBeLessThan(20);
    expect(childFocusPad).toBe(childMetaPad);
  });
});
