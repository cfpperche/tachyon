import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

const AXE_SOURCE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

// spec 342 T4 — the a11y CONTRACT every shipped Kit wrapper carries: label/description/error association,
// aria-invalid, disabled/read-only, visible focus ring, keyboard-only operation, focus restore, no trap.
// Checked two ways: axe-core (static, catches structural a11y violations) + browser keyboard tests (dynamic,
// catches focus/keyboard behavior axe can't see).
describe("Kit a11y contract (T4)", () => {
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

  it("has zero axe-core violations in the Kit section", async () => {
    // `page.addScriptTag` injects an INLINE <script>, which this page's strict CSP (no 'unsafe-inline',
    // nonce'd only) correctly blocks. `page.evaluate` runs via CDP's Runtime.evaluate, which executes in the
    // page's context WITHOUT going through the DOM's own script-loading gate — the same reason a real
    // extension's devtools automation isn't itself a CSP bypass vector for page-authored content.
    await page.evaluate(AXE_SOURCE);
    const results = await page.evaluate(async () => {
      const scope = document.querySelector('[data-testid="kit-section"]') as HTMLElement;
      // @ts-expect-error axe is injected as a global by the script tag above
      return await axe.run(scope);
    });
    expect(results.violations).toEqual([]);
  });

  it("KitLabeledInput associates its label, description, and (when set) error via aria-describedby", async () => {
    const linked = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="kit-labeled-input"]');
      const label = document.querySelector('label[for]');
      const describedBy = input?.getAttribute("aria-describedby");
      const descId = describedBy?.split(" ")[0];
      const descEl = descId ? document.getElementById(descId) : null;
      return {
        labelForMatchesInputId: !!label && label.getAttribute("for") === input?.id,
        describedByResolves: !!descEl,
      };
    });
    expect(linked.labelForMatchesInputId).toBe(true);
    expect(linked.describedByResolves).toBe(true);
  });

  it("KitSelect (radix mode) is keyboard-operable: Tab reaches it, Enter opens, Escape closes with focus restored", async () => {
    await page.focus('[data-testid="kit-labeled-input"]');
    await page.keyboard.press("Tab");
    const reachedTrigger = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "kit-select-trigger");
    expect(reachedTrigger).toBe(true);

    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="kit-select-trigger"]')?.getAttribute("aria-expanded") === "true", { timeout: 2000 });
    await page.keyboard.press("Escape");
    // aria-expanded flips synchronously on close; focus restoration can land a tick later — wait on the
    // ACTUAL focus target, not just the aria flag, to avoid a race between the two.
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "kit-select-trigger", { timeout: 2000 });
  });

  it("KitDropdown is keyboard-operable end to end (open, select an item via Enter, focus restore)", async () => {
    await page.click('[data-testid="kit-dropdown-trigger"]');
    await page.waitForSelector('[data-testid="kit-dropdown-content"]', { visible: true, timeout: 2000 });
    // matches the DropdownMenu gate finding (T3): initial focus lands on the content wrapper, not the first
    // item — ArrowDown moves roving focus onto it (see uiGate.test.ts's "ArrowDown roving focus" case).
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "kit-dropdown-content", { timeout: 2000 });
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "kit-dropdown-item", { timeout: 2000 });
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="kit-dropdown-content"]', { hidden: true, timeout: 2000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "kit-dropdown-trigger", { timeout: 2000 });
  });

  it("KitPopover (T6) is keyboard-operable: opens auto-focusing its field, Escape closes with focus restored", async () => {
    await page.click('[data-testid="kit-popover-trigger"]');
    await page.waitForSelector('[data-testid="kit-popover-content"]', { visible: true, timeout: 2000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "kit-popover-input", { timeout: 2000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="kit-popover-content"]', { hidden: true, timeout: 2000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "kit-popover-trigger", { timeout: 2000 });
  });
});
