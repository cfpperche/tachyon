import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { missionControlFixtures } from "../../scripts/webview-preview/fixtures/mission-control";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import type { MissionControlVM } from "../../src/webview/mission-control/messages";

function hostPage(cspSource: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${cspSource}/dist/webview/codicon.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/design-system.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/vscode-theme.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/mission-control.tailwind.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/mission-control.css">
<title>board card layout</title></head>
<body><div id="root"></div><script src="${cspSource}/dist/webview/mission-control.js"></script></body></html>`;
}

async function loadBoard(page: Page, origin: string): Promise<void> {
  const vm = missionControlFixtures.default!.vm as MissionControlVM;
  await page.setContent(hostPage(origin), { waitUntil: "domcontentloaded" });
  await page.evaluate((fixture) => {
    const onReady = (event: MessageEvent) => {
      const data = event.data as { type?: string } | undefined;
      if (data?.type !== "ready") return;
      window.removeEventListener("message", onReady);
      window.postMessage({ type: "snapshot", vm: fixture }, "*");
    };
    window.addEventListener("message", onReady);
  }, vm);
  await page.waitForSelector('[data-card-id="t-82f870"]', { visible: true, timeout: 5_000 });
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
    await loadBoard(page, server.origin);

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
    await loadBoard(page, server.origin);

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
