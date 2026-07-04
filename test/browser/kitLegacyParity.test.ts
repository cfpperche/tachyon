import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// dogfood round 1 (#2) — "Kit vs legacy heights STILL diverge when mixed": KitSelect's trigger and .ds-input
// must compute to the SAME box (height/border/radius/background) when they sit side by side on a real row,
// since that parity is the entire point of the kit (notes.md's dogfood log). Root cause was design-system.css's
// own unlayered `button` reset silently stripping border/background/padding from every Radix trigger (unlayered
// always beats Tailwind's @layer utilities, regardless of specificity) — fixed via a shared
// `[data-slot="select-trigger"]` rule using the SAME declarations as `.ds-input` (not a hardcoded px height,
// since --ds-mono resolves to the user's own editor font).
describe("Kit vs legacy box-model parity on a mixed row (dogfood #2)", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(server.url, { waitUntil: "networkidle0" });
  });

  afterEach(async () => {
    await page.close();
  });

  const boxOf = (p: Page, selector: string) =>
    p.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        height: Math.round(rect.height),
        borderTopWidth: style.borderTopWidth,
        borderTopColor: style.borderTopColor,
        borderRadius: style.borderTopLeftRadius,
        backgroundColor: style.backgroundColor,
        paddingTop: style.paddingTop,
        paddingLeft: style.paddingLeft,
      };
    }, selector);

  it("KitSelect's trigger computes the SAME height/border/radius/background as .ds-input on the same row", async () => {
    const legacy = await boxOf(page, '[data-testid="legacy-mixed-input"]');
    const kit = await boxOf(page, '[data-testid="kit-select-trigger"]');
    expect(kit.height).toBe(legacy.height);
    expect(kit.borderTopWidth).toBe(legacy.borderTopWidth);
    expect(kit.borderTopColor).toBe(legacy.borderTopColor);
    expect(kit.borderRadius).toBe(legacy.borderRadius);
    expect(kit.backgroundColor).toBe(legacy.backgroundColor);
    expect(kit.paddingTop).toBe(legacy.paddingTop);
    expect(kit.paddingLeft).toBe(legacy.paddingLeft);
  });

  it("every KitSelect trigger on the page (not just one instance) gets the shared box, not a per-panel guess", async () => {
    // regression guard for the OTHER half of the bug: Plugins' old `.plugin-sort` rule guessed a wrong,
    // hardcoded height (28px) that would have kept winning the cascade even after the shared fix landed.
    const legacy = await boxOf(page, '[data-testid="legacy-mixed-input"]');
    const kitSelect = await boxOf(page, '[data-testid="kit-select-trigger"]');
    expect(kitSelect.height).not.toBe(28);
    expect(kitSelect.height).toBe(legacy.height);
  });

  // t-6da5f0 — the board header's search input + KitSelect agent filter (t-b0a229's first board Kit
  // adoption), named here so this fixture doubles as its parity proof — same contract as the Kind/Priority
  // pair above. The header's OWN CSS (`.board-search`'s box model, the +Task/Dropped buttons' height) is
  // covered by test/browser/boardHeaderKitParity.test.ts against the real bundle instead, since this
  // synthetic page never links mission-control.css.
  it("the board header's search input and KitSelect agent filter compute the same height (t-6da5f0)", async () => {
    const input = await boxOf(page, '[data-testid="board-header-search-input"]');
    const select = await boxOf(page, '[data-testid="board-header-agent-select"]');
    expect(select.height).toBe(input.height);
  });
});
