import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { buildDesignModeInjectExpression } from "../../src/webview/ide-browser-bridge/designModeInject.js";

/**
 * t-330a51 — Selection card must not hide the Design Mode chat transcript.
 *
 * Production door: the CDP inject expression runs in a real page (same string the host
 * evaluates). Pick opens both panels; a landed agent bubble must remain hit-testable.
 *
 * 880 is this repo's desktop measure and the typical EDH editor-browser width class.
 * 360 is the narrow pair — side-by-side cannot fit two 360px panels; stack order must
 * still keep the transcript readable.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-330a51");

const PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; padding: 0; background: #fff; color: #111; }
    body { padding: 48px 40px; font-family: system-ui, sans-serif; }
    h1 { font-size: 32px; font-weight: 700; margin: 0 0 12px; }
    p { margin: 0 0 16px; color: #333; }
    button { font: inherit; padding: 4px 10px; }
  </style>
</head>
<body>
  <h1 id="hero">Design Mode Evidence</h1>
  <p>Click to attach a selection for the F8 pack.</p>
  <button type="button">Primary action</button>
</body>
</html>`;

const INJECT = buildDesignModeInjectExpression({
  bindingName: "tachyonDesignModePick",
});

type PanelBox = { left: number; top: number; right: number; bottom: number; width: number; height: number };

function overlaps(a: PanelBox, b: PanelBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function openBothPanels(page: Page): Promise<void> {
  const ok = await page.evaluate((expr) => {
    // eslint-disable-next-line no-eval
    return Boolean(eval(expr));
  }, INJECT);
  expect(ok).toBe(true);
  await page.waitForSelector("#tachyon-dm-root");
  await page.click("#hero");
  await page.waitForFunction(() => {
    const card = document.querySelector("#tachyon-dm-card");
    const chat = document.querySelector("#tachyon-dm-chat");
    return card?.getAttribute("data-open") === "1" && chat?.getAttribute("data-open") === "1";
  });
  await page.evaluate(() => {
    const push = (window as unknown as {
      __tachyonDmChatPush?: (payload: Record<string, unknown>) => void;
    }).__tachyonDmChatPush;
    push?.({ type: "agents", agents: [{ name: "grok", running: true }], active: "grok" });
    push?.({
      type: "message",
      event: {
        v: 1,
        kind: "message",
        role: "agent",
        agent: "grok",
        text: "I see the selected H1 (#hero). It uses system-ui at 32px/700 — good hierarchy for a page title. If you want, I can adjust weight or spacing next.",
        at: "2026-08-12T00:00:00.000Z",
        lineNo: 1,
      },
    });
  });
  await page.waitForSelector("#tachyon-dm-chat-window .dm-chat-bubble");
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null): PanelBox | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const card = document.querySelector("#tachyon-dm-card");
    const chat = document.querySelector("#tachyon-dm-chat");
    const bubble = document.querySelector("#tachyon-dm-chat-window .dm-chat-bubble");
    const br = bubble?.getBoundingClientRect();
    const hit = br
      ? document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2)
      : null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      card: box(card),
      chat: box(chat),
      bubble: box(bubble),
      bothOpen: document.getElementById("tachyon-dm-root")?.getAttribute("data-both-open") ?? null,
      hitId: hit?.closest("#tachyon-dm-card, #tachyon-dm-chat")?.id ?? hit?.id ?? null,
      transcriptCoveredByCard: !!(hit && hit.closest("#tachyon-dm-card")),
    };
  });
}

describe("t-330a51 Design Mode card vs chat overlap", () => {
  let browser: Browser;

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    browser = await puppeteer.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("keeps the landed reply hit-testable at 880×660 without covering the transcript", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 880, height: 660, deviceScaleFactor: 1 });
    await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
    await openBothPanels(page);
    const shot = path.join(OUT_DIR, "t-330a51-880.png");
    await page.screenshot({ path: shot as `${string}.png` });
    const m = await measure(page);
    expect(m.card).toBeTruthy();
    expect(m.chat).toBeTruthy();
    expect(m.bubble).toBeTruthy();
    expect(m.transcriptCoveredByCard).toBe(false);
    expect(overlaps(m.card!, m.chat!)).toBe(false);
    await page.close();
  });

  it("at 360px still keeps the transcript on top when the panels cannot sit side by side", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 360, height: 660, deviceScaleFactor: 1 });
    await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
    await openBothPanels(page);
    const shot = path.join(OUT_DIR, "t-330a51-360.png");
    await page.screenshot({ path: shot as `${string}.png` });
    const m = await measure(page);
    expect(m.bubble).toBeTruthy();
    expect(m.transcriptCoveredByCard).toBe(false);
    await page.close();
  });

  it("header drag still moves the card after both panels open", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 880, height: 660, deviceScaleFactor: 1 });
    await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
    await openBothPanels(page);
    const before = await measure(page);
    const handle = await page.$("#tachyon-dm-card-drag");
    expect(handle).toBeTruthy();
    const box = await handle!.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 - 80, box!.y + box!.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    const after = await measure(page);
    expect(after.card!.left).toBeLessThan(before.card!.left - 20);
    expect(after.transcriptCoveredByCard).toBe(false);
    await page.close();
  });
});
