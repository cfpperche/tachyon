import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// t-c55f8d (2026-08-01) replaced this test's hand-rolled host page with the preview harness, after the board
// stopped shipping its own `dist/webview/mission-control.js` and the page rendered empty on a 404'd script.
// SDD 485 C5 (2026-08-03): that bundle exists again — the Board is a standalone app — so the route is the
// board's own, pushing the SAME missionControlFixtures.default VM through the same shared envelope.
// `width`/`height` size the preview frame to the viewport, so the lane-width and board-scroller
// measurements below still measure what they measured before.
const PREVIEW = "/scripts/webview-preview/index.html?view=mission-control&fixture=default";

async function loadBoard(page: Page, origin: string, frame: { width: number; height: number }): Promise<void> {
  await page.goto(`${origin}${PREVIEW}&width=${frame.width}&height=${frame.height}`, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-card-id="t-82f870"]', { visible: true, timeout: 15_000 });
}

type Box = { left: number; right: number; top: number; bottom: number; width: number };

describe("SDD 419 — Board card metadata layout", () => {
  let server: GateServer;
  let browser: Browser;

  beforeAll(async () => {
    mkdirSync(".tachyon/vqa/visual-qa", { recursive: true });
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("keeps author/badges and id/assignee-priority in independent opposite regions", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await loadBoard(page, server.origin, { width: 1440, height: 900 });

    const result = await page.$eval('[data-card-id="t-82f870"]', (card) => {
      const box = (selector: string): Box => {
        const rect = card.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
      };
      const author = card.querySelector<HTMLElement>(".card-author")!;
      return {
        columnWidth: card.closest(".col")!.getBoundingClientRect().width,
        author: box(".card-author"),
        badges: box(".card-badges"),
        title: box(".title"),
        id: box(".ref-copy"),
        controls: box(".quick-controls"),
        authorText: author.textContent,
        authorHasDot: !!author.querySelector(".dot"),
      };
    });

    expect(result.columnWidth).toBe(300);
    expect(result.authorText).toBe("author-with-a-deliberately-long-name");
    expect(result.author.width).toBeGreaterThan(0);
    expect(result.authorHasDot).toBe(false);
    expect(result.author.left).toBeLessThan(result.badges.left);
    expect(result.author.right).toBeLessThanOrEqual(result.badges.left);
    expect(result.author.bottom).toBeLessThanOrEqual(result.title.top);
    expect(result.id.left).toBeLessThan(result.controls.left);
    expect(result.id.right).toBeLessThanOrEqual(result.controls.left);
    expect(result.title.bottom).toBeLessThanOrEqual(result.id.top);

    await page.screenshot({ path: ".tachyon/vqa/visual-qa/board-card-layout-1440x900.png" });

    await page.close();
  });

  it("keeps 300px lanes and delegates narrow overflow to the board scroller", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });
    await loadBoard(page, server.origin, { width: 900, height: 900 });

    const layout = await page.$eval(".board", (board) => ({
      clientWidth: board.clientWidth,
      scrollWidth: board.scrollWidth,
      widths: [...board.querySelectorAll<HTMLElement>(".col")].map((column) => column.getBoundingClientRect().width),
    }));
    expect(layout.widths.every((width) => width === 300)).toBe(true);
    expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);

    await page.screenshot({ path: ".tachyon/vqa/visual-qa/board-card-layout-900x900.png" });

    await page.close();
  });
});
