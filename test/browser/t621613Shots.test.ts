import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

// t-621613 — visual evidence for the Worktrees tab's orphan agent row, at this repo's two widths.
//
// ANCHOR, written before the change and taken from the problem statement rather than from the
// screen: a human looking at Control → Worktrees must be able to tell, without clicking, which
// agent checkouts are somebody's home and which are leftovers nothing else can reach — and must be
// able to act on the leftover from the standalone Worktrees app. Both widths keep every row's actions reachable and
// never overflow the page horizontally.
//
// It caught its defect on the first run: the reason sentence started life in the ACTIONS column and
// at 880px squeezed the row's main column into a four-character strip, wrapping the branch mid-word.
// It now renders where the other per-row reasons do. That is why the width pair is not optional —
// 360 alone would have shown a stacked row that looked fine.
// Same gitignored home the other shot tests use — evidence, never a repo artifact.
const OUT = process.env.T621613_SHOT_DIR ?? ".tachyon/vqa/visual-qa";

describe("t-621613 worktrees tab shots", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), args: ["--no-sandbox"] });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  for (const width of [880, 360]) {
    it(`renders at ${width}`, async () => {
      // SDD 485 D6 wanted both dimensions set because the harness sized a DIV; t-b24282 made the frame
      // an iframe, so `?width=` IS the surface viewport and one number drives media queries and layout
      // box alike. The browser viewport is set only so the capture below is not cropped.
      await page.setViewport({ width, height: 1000 });
      const surface = await openPreview(page, server.origin, {
        query: { view: "worktrees", fixture: "default" },
        width,
        height: 1000,
        waitFor: '[data-testid="control-worktrees"]',
      });
      await page.screenshot({ path: `${OUT}/t621613-worktrees-${width}.png`, fullPage: true });
      const overflow = await surface.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      expect(overflow, `horizontal overflow at ${width}`).toBe(true);
      expect(await surface.evaluate(() => window.innerWidth)).toBe(width);
      const texts = await surface.evaluate(() => document.body.innerText);
      expect(texts).toContain("Agent no longer exists");
      expect(texts).toContain("Managed by Agent Studio");
    });
  }
});
