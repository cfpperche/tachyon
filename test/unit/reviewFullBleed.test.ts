import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-abe33b — review body full-bleed is a LOCAL opt-out of `.ds-page`, not a change to the shared shell.
 *
 * The shared `.ds-page` pad is the Fleet document inset. Review is a two-column data surface and
 * wants the body flush to the frame; the header keeps the inset. A global edit of `.ds-page` or
 * `--ds-page-pad-*` would move Board, Handoff, Validations and Approval with it.
 */

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8");

const DESIGN_SYSTEM_CSS = "packages/webview-ui/src/webview/shared/design-system.css";
const REVIEW_CSS = "packages/webview-ui/src/webview/review/review.css";
const TOKENS_CSS = "packages/webview-ui/src/webview/shared/tokens.css";

function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  }
  return out;
}

function rulesFor(css: string, selector: string): { selector: string; body: string }[] {
  return rules(css).filter((r) => r.selector.split(",").some((part) => part.trim().replace(/\s+/g, " ") === selector));
}

function declaration(body: string, prop: string): string | undefined {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`, "i"));
  return m?.[1].trim();
}

function joined(css: string, selector: string): string {
  return rulesFor(css, selector).map((r) => r.body).join(";");
}

describe("t-abe33b — review body full-bleed is a local opt-out", () => {
  it("does not change the shared .ds-page pad or the --ds-page-pad-* tokens", () => {
    const ds = read(DESIGN_SYSTEM_CSS);
    const padding = rulesFor(ds, ".ds-page").map((r) => declaration(r.body, "padding")).find((v) => v !== undefined);
    expect(padding).toBe("var(--ds-page-pad-y) var(--ds-page-pad-x) var(--ds-page-pad-bottom)");

    const tokens = read(TOKENS_CSS);
    expect(tokens).toMatch(/--ds-page-pad-x:\s*var\(--ds-4\)/);
    expect(tokens).toMatch(/--ds-page-pad-y:\s*var\(--ds-3\)/);
    expect(tokens).toMatch(/--ds-page-pad-bottom:\s*var\(--ds-5\)/);
  });

  it("zeros only the review root's side and bottom pad, leaving the shared top inset", () => {
    const css = read(REVIEW_CSS);
    const body = joined(css, ".review-root.ds-page");
    expect(body, "review.css must opt .review-root.ds-page out of side/bottom pad").not.toBe("");
    expect(declaration(body, "padding-left")).toBe("0");
    expect(declaration(body, "padding-right")).toBe("0");
    expect(declaration(body, "padding-bottom")).toBe("0");
    expect(declaration(body, "padding-top"), "top pad stays on .ds-page so the header keeps its inset").toBeUndefined();
    expect(declaration(body, "padding"), "do not replace the shared shorthand; override the three longhands").toBeUndefined();
  });

  it("keeps the header inset with the shared pad token, not a new length", () => {
    const css = read(REVIEW_CSS);
    const body = joined(css, ".review-root > .ds-page-chrome");
    expect(body).not.toBe("");
    const inline = declaration(body, "padding-inline");
    const left = declaration(body, "padding-left");
    const right = declaration(body, "padding-right");
    if (inline) {
      expect(inline).toBe("var(--ds-page-pad-x)");
    } else {
      expect(left).toBe("var(--ds-page-pad-x)");
      expect(right).toBe("var(--ds-page-pad-x)");
    }
  });

  it("keeps the body top border that separates header from content", () => {
    const css = read(REVIEW_CSS);
    const body = joined(css, ".review-body");
    expect(declaration(body, "border-top")).toBe("var(--ds-border-width) solid var(--ds-border)");
  });

  it("t-2f7e8c — file-list default width stays today's 16rem", () => {
    const css = read(REVIEW_CSS);
    const files = joined(css, ".review-files");
    expect(declaration(files, "width")).toBe("var(--review-files-width, 16rem)");
    expect(declaration(files, "border-right")).toBe("var(--ds-border-width) solid var(--ds-border)");
  });

  it("t-2f7e8c — stacked layout hides the splitter", () => {
    const css = read(REVIEW_CSS);
    expect(css).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*\.review-split\s*\{[\s\S]*display:\s*none/);
  });
});
