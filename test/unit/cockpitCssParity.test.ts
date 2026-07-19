import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTES } from "../../scripts/webview-preview/routes.js";

// t-6bbdf6 — the webview-preview harness's cockpit route drifted from the real Control host: the host linked
// validations.css but the harness didn't, so the harness rendered the Validations tab unstyled (and baked that
// into fixture screenshots). A "does it link validations.css" test would only guard the one file that already
// broke, so this asserts PARITY instead: the harness's cockpit cssLinks are the SAME product CSS set, in the
// SAME order, as the real host's.
//
// Cockpit.ts composes its link set inline (`uri("x.css")` inside renderWebviewShell's `styles:`) with no
// exported symbol to import, so we source-scan that one array — the tolerant-source-scan pattern already used
// by webviewConvention.test.ts. If a future refactor exports a real constant, import it here instead.

const COCKPIT_HOST = "src/webview/Cockpit.ts";

/** the css basenames the real Control host links, in link order, read out of its renderWebviewShell call. */
function hostCssOrder(): string[] {
  const src = readFileSync(COCKPIT_HOST, "utf8");
  const block = /\bstyles:\s*\[([\s\S]*?)\]/.exec(src);
  expect(block, `${COCKPIT_HOST}: no \`styles: [...]\` array found — did the shell call move or get renamed?`).not.toBeNull();
  return [...block![1].matchAll(/uri\(\s*["'`]([^"'`]+\.css)["'`]\s*\)/g)].map((m) => m[1]);
}

/** the css basenames the harness cockpit route links, in link order. */
function harnessCssOrder(): string[] {
  return ROUTES.cockpit.cssLinks.map((href) => href.slice(href.lastIndexOf("/") + 1));
}

describe("cockpit css parity (harness ↔ real Control host)", () => {
  it("reads a non-trivial link set out of the real host (guard against a silently-empty scan)", () => {
    const host = hostCssOrder();
    // a broken regex that matched nothing would make every parity assertion below vacuously pass.
    expect(host.length).toBeGreaterThan(5);
    expect(host).toContain("cockpit.css");
    expect(new Set(host).size, `${COCKPIT_HOST}: duplicate css link`).toBe(host.length);
  });

  it("the harness cockpit route links the same product CSS, in the same order, as the real host", () => {
    // order is a real contract, not cosmetics: these files cascade over each other.
    expect(harnessCssOrder()).toEqual(hostCssOrder());
  });

  it("cockpit.css stays LAST in both (its own header comment: 'linked LAST — these rules must win')", () => {
    // cockpit.css hard-resets html/body/#root globals that the embedded surfaces' standalone CSS sets;
    // anything linked after it would break every Control tab.
    expect(hostCssOrder().at(-1)).toBe("cockpit.css");
    expect(harnessCssOrder().at(-1)).toBe("cockpit.css");
  });

  it("links validations.css — the embedded Validations tab's own stylesheet (the t-6bbdf6 regression)", () => {
    expect(hostCssOrder()).toContain("validations.css");
    expect(harnessCssOrder()).toContain("validations.css");
  });
});
