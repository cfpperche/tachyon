import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

// ANCHOR (written before the change): Overview is a status dashboard — metrics + bridges —
// not a second navigation surface. After JUMP removal the page must still read cleanly at
// desktop and narrow widths with no empty Jump hole and no horizontal overflow.
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
    it(`renders without JUMP at ${width} (?width= is the surface viewport; prove innerWidth)`, async () => {
      // t-b24282 — the harness frame is an iframe, so one `?width=` moves both the layout box and the
      // viewport `@media` reads. The browser viewport is set only so the capture below is not cropped.
      await page.setViewport({ width, height: 1000 });
      const surface = await openPreview(page, server.origin, {
        query: { view: "overview", fixture: "default" },
        width,
        height: 1000,
        waitFor: '[data-testid="control-overview"]',
      });
      expect(await surface.evaluate(() => window.innerWidth)).toBe(width);
      expect(
        await surface.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `horizontal overflow at ${width}`,
      ).toBe(true);
      const text = await surface.evaluate(() => document.body.innerText);
      expect(text).not.toMatch(/\bJump\b/);
      expect(text).not.toMatch(/\bDoctor\b/);
      expect(text).toMatch(/Overview|Workspaces|Engines|Agents|Inbox|Bridges/i);
      await page.screenshot({ path: `${OUT}/t3bcd57-overview-${width}.png`, fullPage: true });
    });
  }
});
