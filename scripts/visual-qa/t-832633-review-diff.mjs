/**
 * t-832633 — two-width visual pass for the SDD 513 fatia 2 review screen.
 *
 * ANCHOR, from the card before the capture: the Tachyon review screen shows one
 * unified diff at a time, a file list, a clickable ruler on the modified side,
 * and notes. A file above 20_000 characters must SAY "realce desativado neste
 * arquivo (grande)" — silent degrade is the defect. Two notes stay visible: one
 * migrated, one outdated. At 880 the list sits beside the diff; at 360 they
 * stack and the notes still read.
 *
 * This page is NOT a catalog ROUTES entry. Adding one requires a WEBVIEW_SURFACES
 * host + serializer (fatia 3). The screen is consumed through a standalone
 * preview page that loads the same review.js bundle.
 *
 * Prereq: `node esbuild.mjs`, then `PREVIEW_PORT=5274 node scripts/webview-preview/serve.mjs`.
 * Run: `PREVIEW_PORT=5274 node scripts/visual-qa/t-832633-review-diff.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/t-832633";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const origin = process.env.PREVIEW_ORIGIN ?? `http://localhost:${process.env.PREVIEW_PORT ?? 5174}`;

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = [];
for (const w of widths) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 900 });
  await page.goto(`${origin}/scripts/webview-preview/review-fatia2.html`, {
    waitUntil: "networkidle0",
    timeout: 45000,
  });
  await page.waitForSelector("[data-testid=review-root]", { timeout: 45000 });
  await page.waitForSelector("[data-testid=review-highlight-off]", { timeout: 45000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const shot = `${outDir}/review-large-${w}.png`;
  await page.screenshot({ path: shot, fullPage: true });
  const facts = await page.evaluate(() => {
    const banner = document.querySelector("[data-testid=review-highlight-off]")?.textContent?.trim() ?? "";
    const notes = [...document.querySelectorAll(".review-note")].map((note) => ({
      id: note.getAttribute("data-testid"),
      status: note.getAttribute("data-status"),
      reconcile: note.getAttribute("data-reconcile"),
      text: note.querySelector(".review-note-body")?.textContent?.trim() ?? "",
    }));
    const files = [...document.querySelectorAll(".review-file")].map((row) => ({
      path: row.querySelector(".review-file-path")?.textContent?.trim() ?? "",
      status: row.getAttribute("data-status"),
    }));
    return {
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      banner,
      notes,
      files,
      stacked: getComputedStyle(document.querySelector(".review-body")).flexDirection === "column",
    };
  });
  report.push({ width: w, shot, ...facts });
  await page.close();
}

await browser.close();
writeFileSync(`${outDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
