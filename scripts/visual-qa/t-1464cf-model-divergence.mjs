/**
 * t-1464cf — two-width visual pass for `≠ declared`.
 *
 * ANCHOR, from the card before the capture: agents without an explicit `--model` must not wear
 * `≠ declared` even when the observed label differs from the profile default. A real mismatch —
 * spawn pinned `--model X`, transcript shows Y — still must. Five rows without the marker, one
 * with it. At 360 the names/markers still fit; nothing overflows.
 *
 * Prereq: `node esbuild.mjs`, then `PREVIEW_PORT=5274 node scripts/webview-preview/serve.mjs`.
 * Run: `PREVIEW_PORT=5274 node scripts/visual-qa/t-1464cf-model-divergence.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { openPreview } from "./preview-surface.mjs";

const outDir = process.argv[2] ?? ".vqa/t-1464cf";
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
  await page.setViewport({ width: w, height: 900 });
  const surface = await openPreview(page, {
    view: "sidebar",
    fixture: "model-divergence",
    width: w,
    height: 900,
    waitFor: ".row",
    settleMs: 300,
  });
  const shot = `${outDir}/model-divergence-${w}.png`;
  await page.screenshot({ path: shot, fullPage: true });
  const facts = await surface.evaluate(() => {
    const rows = [...document.querySelectorAll(".row")].map((row) => ({
      name: row.querySelector(".name")?.textContent?.trim() ?? "",
      model: row.querySelector(".model")?.textContent?.trim() ?? "",
      marker: row.querySelector(".model-marker")?.textContent?.trim() ?? "",
    }));
    return {
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rows,
    };
  });
  report.push({ width: w, shot, ...facts });
  await page.close();
}

await browser.close();
writeFileSync(`${outDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
