/**
 * t-abe33b — two-width visual pass for the review body full-bleed opt-out.
 *
 * ANCHOR, from the owner's looking-at-0.93.12 request, written before the CSS change:
 *
 *   The Review header keeps the shared `.ds-page` inset (title/actions spacing stays).
 *   The two-column body (file list + diff) is flush with the left, right and bottom
 *   edges of the webview. The body's top border still separates header from content.
 *   Diff code is not hidden under the scrollbar. Board keeps its existing page-pad
 *   margins — this is not a global `.ds-page` change.
 *
 * Prereq: `npm run build`, then `PREVIEW_PORT=… node scripts/webview-preview/serve.mjs`.
 * Run: `PREVIEW_PORT=… node scripts/visual-qa/t-abe33b-review-bleed.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/t-abe33b";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = [];
for (const w of widths) {
  const page = await browser.newPage();
  await page.setViewport({ width: w + 40, height: 940, deviceScaleFactor: 2 });
  const surface = await openPreview(page, {
    view: "review",
    fixture: "default",
    width: w,
    height: 900,
    waitFor: "[data-testid=review-root]",
    settleMs: 300,
  });
  const facts = await surface.evaluate(() => {
    const pads = (() => {
      const probe = document.createElement("div");
      probe.style.paddingLeft = "var(--ds-page-pad-x)";
      probe.style.paddingBottom = "var(--ds-page-pad-bottom)";
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const out = { padX: parseFloat(cs.paddingLeft), padBottom: parseFloat(cs.paddingBottom) };
      probe.remove();
      return out;
    })();
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)];
    };
    const body = document.querySelector(".review-body");
    const files = document.querySelector(".review-files");
    const pane = document.querySelector(".review-pane");
    const code = document.querySelector(".review-code");
    return {
      frame: [document.documentElement.clientWidth, document.documentElement.clientHeight],
      ...pads,
      titleLeft: Math.round(document.querySelector(".ds-page-chrome-title")?.getBoundingClientRect().left ?? -1),
      body: r(".review-body"),
      files: r(".review-files"),
      chrome: r(".ds-page-chrome"),
      flex: body ? getComputedStyle(body).flexDirection : null,
      bodyBorderTop: body ? getComputedStyle(body).borderTopWidth : null,
      filesBorderRight: files ? getComputedStyle(files).borderRightWidth : null,
      paneClientW: pane ? pane.clientWidth : null,
      codeRight: code ? Math.round(code.getBoundingClientRect().right) : null,
    };
  });
  const shot = `${outDir}/review-${w}.png`;
  await (await page.$("#frame")).screenshot({ path: shot });
  report.push({ surface: "review", width: w, shot, ...facts });
  await page.close();
}

{
  const page = await browser.newPage();
  await page.setViewport({ width: 920, height: 940, deviceScaleFactor: 2 });
  const surface = await openPreview(page, {
    view: "board",
    fixture: "default",
    width: 880,
    height: 900,
    waitFor: ".mc-root",
    settleMs: 400,
  });
  const facts = await surface.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.paddingLeft = "var(--ds-page-pad-x)";
    probe.style.paddingBottom = "var(--ds-page-pad-bottom)";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const pads = { padX: parseFloat(cs.paddingLeft), padBottom: parseFloat(cs.paddingBottom) };
    probe.remove();
    const head = document.querySelector(".mc-head");
    const board = document.querySelector(".board");
    const col = document.querySelector(".col");
    return {
      frame: [document.documentElement.clientWidth, document.documentElement.clientHeight],
      ...pads,
      headPadX: head ? parseFloat(getComputedStyle(head).paddingLeft) : null,
      boardPadX: board ? parseFloat(getComputedStyle(board).paddingLeft) : null,
      boardPadBottom: board ? parseFloat(getComputedStyle(board).paddingBottom) : null,
      colLeft: col ? Math.round(col.getBoundingClientRect().left) : null,
    };
  });
  const shot = `${outDir}/board-880.png`;
  await (await page.$("#frame")).screenshot({ path: shot });
  report.push({ surface: "board", width: 880, shot, ...facts });
  await page.close();
}

await browser.close();
writeFileSync(`${outDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
