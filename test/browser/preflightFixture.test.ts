import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// spec 342 T4 — "Tailwind v4 pipeline, preflight off" acceptance fixture: a mixed .ds-* fixture (button,
// input, select, table, list, heading) must compute IDENTICAL styles whether or not Tailwind's compiled CSS
// is linked on the page. The gate page (`/ui-gate`) links vscode-theme.css + Tailwind; the twin
// (`/preflight-fixture-no-tailwind`) links only the shared baseline — both render the SAME
// PREFLIGHT_FIXTURE_HTML string (see src/webview/ui-gate/preflightFixture.ts), so any computed-style diff is
// attributable to Tailwind's inclusion, not to markup drift between two hand-copies.
const PROPERTIES = [
  "boxSizing",
  "borderTopWidth",
  "borderTopStyle",
  "borderTopColor",
  "paddingTop",
  "paddingLeft",
  "marginTop",
  "marginLeft",
  "fontSize",
  "fontFamily",
  "outlineStyle",
  "backgroundColor",
] as const;

describe("preflight OFF: mixed .ds-* fixture computed styles", () => {
  let browser: Browser;
  let server: GateServer;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("computes identical styles on every fixture element with and without Tailwind linked", async () => {
    const withTailwind = await browser.newPage();
    await withTailwind.goto(server.url, { waitUntil: "networkidle0" });
    const withoutTailwind = await browser.newPage();
    await withoutTailwind.goto(server.preflightFixtureNoTailwindUrl, { waitUntil: "networkidle0" });

    const computedStylesFor = (p: typeof withTailwind, scopeSelector: string) =>
      p.evaluate(
        (scope, props) => {
          const root = document.querySelector(scope) ?? document.body;
          const elements = root.querySelectorAll("[data-testid^='fixture-']");
          const out: Record<string, Record<string, string>> = {};
          for (const el of Array.from(elements)) {
            const testId = el.getAttribute("data-testid")!;
            const cs = getComputedStyle(el);
            out[testId] = Object.fromEntries(props.map((prop) => [prop, cs[prop as keyof CSSStyleDeclaration] as string]));
          }
          return out;
        },
        scopeSelector,
        PROPERTIES,
      );

    const withStyles = await computedStylesFor(withTailwind, '[data-testid="preflight-fixture"]');
    const withoutStyles = await computedStylesFor(withoutTailwind, "body");

    expect(Object.keys(withStyles).sort()).toEqual(Object.keys(withoutStyles).sort());
    for (const testId of Object.keys(withStyles)) {
      expect(withStyles[testId], `element ${testId}`).toEqual(withoutStyles[testId]);
    }

    await withTailwind.close();
    await withoutTailwind.close();
  });
});
