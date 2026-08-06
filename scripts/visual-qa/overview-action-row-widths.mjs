/**
 * t-89ecfe — the two-width visual pass for the Overview action row.
 *
 * ANCHOR, written from the task's problem statement BEFORE the surface was measured (an anchor written
 * afterwards only proves the screenshot matches itself):
 *
 *   At 360px, the Overview action row (`.ck-overview-actions` — the Auto-refresh checkbox, the Refresh
 *   button, the Copy diagnostics button) must keep every control fully inside the visible page: each
 *   control's right edge must land at or before the page's own clientWidth, whether that means the row
 *   fits on one line or wraps to more than one. "Copy diagnostics" in particular — the action a human
 *   reaches for when something is already wrong — must stay present, legible and clickable, never pushed
 *   past the right edge into space the page cannot reach. At 880px the same row must render exactly as it
 *   does today: unchanged position, unchanged line count. Nothing here may regress the wide layout.
 *
 * Harness rule this repo paid for (t-b24282): `?width=` must be measured through the sized IFRAME the
 * harness now provides, not a div — a div lets `@media`/viewport-relative layout keep reading the
 * browser's own width, which manufactures horizontal "clipping" that the product never produces.
 *
 * Prereq: `node esbuild.mjs` and `npm run preview:webview` in another shell.
 * Run: `node scripts/visual-qa/overview-action-row-widths.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? ".tachyon/visual-qa/t-89ecfe";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

let bad = 0;
let ran = 0;
for (const w of widths) {
  ran += 1;
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 900 });
  // t-b24282 — the width goes to the harness once; the surface's DOM lives in the returned frame.
  const surface = await openPreview(page, { view: "overview", fixture: "default", width: w, height: 900, settleMs: 700 });

  const m = await surface.evaluate(() => {
    const de = document.documentElement;
    const actions = document.querySelector(".ck-overview-actions");
    const copyBtn = [...document.querySelectorAll(".ck-overview-actions button")]
      .find((b) => /diagnostics/i.test(b.textContent ?? ""));
    const scrolls = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      }
      return false;
    };
    const over = actions ? [...actions.querySelectorAll("*")]
      .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 34)}`) : [];
    const rect = (el) => el ? el.getBoundingClientRect() : null;
    const cr = rect(copyBtn);
    const ar = rect(actions);
    return {
      rendered: !!actions,
      clientW: de.clientWidth,
      scrollW: de.scrollWidth,
      actionsRight: ar ? Math.round(ar.right) : null,
      copyBtnFound: !!copyBtn,
      copyBtnRight: cr ? Math.round(cr.right) : null,
      copyBtnVisible: cr ? (cr.right <= de.clientWidth + 0.5 && cr.left >= -0.5 && cr.width > 0 && cr.height > 0) : false,
      copyBtnText: copyBtn ? copyBtn.textContent.trim() : null,
      rowLines: actions ? new Set([...actions.children].map((c) => Math.round(c.getBoundingClientRect().top))).size : 0,
      over: over.slice(0, 4),
    };
  });

  await page.screenshot({ path: `${outDir}/control-overview-${w}.png`, fullPage: true });

  const noOverflow = m.scrollW <= m.clientW + 0.5 && m.over.length === 0;
  const ok = m.rendered && m.copyBtnFound && m.copyBtnVisible && noOverflow;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} overview@${w} clientW=${m.clientW} scrollW=${m.scrollW} actionsRight=${m.actionsRight} ` +
      `copyBtn="${m.copyBtnText}" right=${m.copyBtnRight} visible=${m.copyBtnVisible} lines=${m.rowLines}` +
      (m.over.length ? ` over=${JSON.stringify(m.over)}` : ""),
  );
  await page.close();
}

await browser.close();
console.log(bad === 0 ? `\nVISUAL QA PASS — ${ran}/${ran}, screenshots in ${outDir}` : `\nVISUAL QA FAIL — ${bad}/${ran}`);
process.exit(bad ? 1 : 0);
