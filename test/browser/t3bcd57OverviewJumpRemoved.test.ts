import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// ANCHOR (written before the change): Overview is a status dashboard — metrics + bridges —
// not a second navigation surface. After JUMP removal the page must still read cleanly at
// desktop and narrow widths with no empty Jump hole and no horizontal overflow.
const PREVIEW = "/scripts/webview-preview/index.html?view=overview&fixture=default";
const OUT = process.env.T3BCD57_SHOT_DIR ?? ".tachyon/vqa/visual-qa";

describe("t-3bcd57 Overview without JUMP card", () => {
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
    it(`renders without JUMP at ${width} (viewport + ?width=; prove innerWidth)`, async () => {
      await page.setViewport({ width, height: 1000 });
      await page.goto(`${server.origin}${PREVIEW}&width=${width}`, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="control-overview"]', { visible: true, timeout: 10_000 });
      await page.evaluate((w) => {
        const frame = document.getElementById("frame");
        if (frame) { frame.style.width = `${w}px`; frame.style.height = "1000px"; }
      }, width);
      expect(await page.evaluate(() => window.innerWidth)).toBe(width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `horizontal overflow at ${width}`,
      ).toBe(true);
      const text = await page.evaluate(() => document.body.innerText);
      expect(text).not.toMatch(/\bJump\b/);
      expect(text).not.toMatch(/\bDoctor\b/);
      expect(text).toMatch(/Overview|Workspaces|Engines|Agents|Inbox|Bridges/i);
      await page.screenshot({ path: `${OUT}/t3bcd57-overview-${width}.png`, fullPage: true });
    });
  }
});
