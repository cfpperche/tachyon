import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// ANCHOR, written before the standalone Fleet implementation: Fleet remains a dense operational list
// whose agent identity, state and actions are readable and reachable at desktop and narrow widths. The
// standalone cutover must preserve the familiar page chrome and must not introduce horizontal overflow.
const PREVIEW = "/scripts/webview-preview/index.html?view=fleet&fixture=default";
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
      await page.setViewport({ width, height: 1000 });
      await page.goto(`${server.origin}${PREVIEW}&width=${width}`, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="control-fleet"]', { visible: true, timeout: 10_000 });
      await page.evaluate((w) => {
        const frame = document.getElementById("frame");
        if (frame) { frame.style.width = `${w}px`; frame.style.height = "1000px"; }
      }, width);
      expect(await page.evaluate(() => window.innerWidth)).toBe(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal overflow at ${width}`).toBe(true);
      expect(await page.evaluate(() => document.body.innerText)).toContain("Open Board");
      await page.screenshot({ path: `${OUT}/t77607a-fleet-${width}.png`, fullPage: true });
    });
  }
});
