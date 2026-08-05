import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

// ANCHOR, written before the standalone Fleet implementation: Fleet remains a dense operational list
// whose agent identity, state and actions are readable and reachable at desktop and narrow widths. The
// standalone cutover must preserve the familiar page chrome and must not introduce horizontal overflow.
const OUT = process.env.T77607A_SHOT_DIR ?? ".tachyon/vqa/visual-qa";

describe("t-77607a standalone Fleet visual evidence", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), args: ["--no-sandbox"] });
    page = await browser.newPage();
  });

  afterAll(async () => { await browser?.close(); await server?.close(); });

  for (const width of [880, 360]) {
    it(`renders at ${width}`, async () => {
      // t-b24282 — ONE number. The harness frame is an iframe, so `?width=` is the surface's viewport:
      // media queries and container width move together, and the hand-resize this test used to need is
      // gone. The browser viewport is set only so the capture below is not cropped.
      await page.setViewport({ width, height: 1000 });
      const surface = await openPreview(page, server.origin, {
        query: { view: "fleet", fixture: "default" },
        width,
        height: 1000,
        waitFor: '[data-testid="control-fleet"]',
      });
      expect(await surface.evaluate(() => window.innerWidth)).toBe(width);
      expect(await surface.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal overflow at ${width}`).toBe(true);
      expect(await surface.evaluate(() => document.body.innerText)).toContain("Open Board");
      await page.screenshot({ path: `${OUT}/t77607a-fleet-${width}.png`, fullPage: true });
    });
  }
});
