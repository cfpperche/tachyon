/**
 * t-475b9b — the two close-ups the full-page captures cannot show at readable size.
 *
 * Same anchor as `agent-studio-evolution-removal.mjs`; this only zooms the two places the removal
 * actually touched the layout, at 2x, so a human can judge them instead of squinting at a 2600px
 * page scaled to fit:
 *
 *   `seam`       — persistent instructions → check grid, where `EvolutionSection` used to be.
 *   `provenance` — the "Profile sources and authority" grid, which lost its 4th card ("Learned state").
 *
 * Prereq: `node esbuild.mjs` and `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT respected).
 * Run: `node scripts/visual-qa/agent-studio-evolution-seam-detail.mjs [outDir] [label]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { openPreview } from "./preview-surface.mjs";

const outDir = process.argv[2] ?? ".vqa/t-475b9b";
const label = process.argv[3] ?? "detail";
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = [];

/** The iframe's own offset inside the harness page, so a frame-relative rect can be clipped by the page. */
async function frameOffset(page) {
  return page.evaluate(() => {
    const r = document.querySelector("iframe#frame").getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY };
  });
}

for (const [fixture, width, height] of [["canonical-disabled", 880, 3000], ["new", 880, 1000], ["new", 360, 1300]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: width + 20, height, deviceScaleFactor: 2 });
  const surface = await openPreview(page, { view: "agent-studio-shell", fixture, width, height, settleMs: 250 });
  const off = await frameOffset(page);

  const rects = await surface.evaluate(() => {
    const pick = (el, pad = 12) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
    };
    const column = document.querySelector(".ash-fields");
    const kids = column ? [...column.children] : [];
    const instructions = kids.find((k) => /persistent instructions/i.test(k.textContent ?? ""));
    const checks = document.querySelector(".ash-check-grid");
    const grid = document.querySelector(".ash-profile-source-grid");
    const seamBox = instructions && checks
      ? (() => {
          const a = instructions.getBoundingClientRect();
          const b = checks.getBoundingClientRect();
          return { x: a.left - 12, y: a.top - 12, width: Math.max(a.width, b.width) + 24, height: b.bottom - a.top + 24 };
        })()
      : null;
    // Grid measurement: how many cards, and does the last row leave a cell empty?
    const cards = [...document.querySelectorAll(".ash-profile-source")].map((c) => {
      const r = c.getBoundingClientRect();
      return { title: (c.querySelector("strong")?.textContent ?? "").trim(), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) };
    });
    const gridBox = grid?.getBoundingClientRect();
    const rowsOf = {};
    for (const c of cards) (rowsOf[c.y] ??= []).push(c);
    const rows = Object.values(rowsOf);
    return {
      seam: seamBox,
      provenance: pick(grid),
      cards,
      columnsPerRow: rows.map((r) => r.length),
      gridWidth: gridBox ? Math.round(gridBox.width) : 0,
      // The empty half-cell, if any: grid width minus the last row's occupied width.
      lastRowEmptyPx: rows.length && gridBox
        ? Math.round(gridBox.width - rows[rows.length - 1].reduce((s, c) => s + c.w, 0) - (rows[rows.length - 1].length - 1) * 8)
        : 0,
    };
  });

  for (const key of ["seam", "provenance"]) {
    const r = rects[key];
    if (!r || r.height <= 0) continue;
    const file = `${outDir}/${label}-${fixture}-${width}-${key}.png`;
    await page.screenshot({
      path: file,
      clip: { x: Math.max(0, r.x + off.x), y: Math.max(0, r.y + off.y), width: r.width, height: r.height },
    });
    report.push({ fixture, width, region: key, file });
  }
  report.push({ fixture, width, cards: rects.cards, columnsPerRow: rects.columnsPerRow, gridWidth: rects.gridWidth, lastRowEmptyPx: rects.lastRowEmptyPx });
  await page.close();
}

await browser.close();
writeFileSync(`${outDir}/${label}-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
