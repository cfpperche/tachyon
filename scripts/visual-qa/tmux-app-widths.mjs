/**
 * SDD 485 D1 — the two-width visual pass for the tmux Server Inspector as a standalone app.
 *
 * ANCHOR, written from the task's problem statement BEFORE the surface was measured (an anchor written
 * afterwards only proves the screenshot matches itself):
 *
 *   The inspector must arrive as a first-class editor tab showing the SAME server it showed inside
 *   Control — nothing gained and nothing lost by the move. At 880: the page chrome on one row above the
 *   Overview/Server tabs, the five-column filter bar on one row below them, and session rows reading
 *   left-to-right as status · label · meta · age · actions, with the surface's own single page pad rather
 *   than doubled or absent where Control's shell used to be. At 360: usable rather than clipping — the
 *   filter bar reflowing instead of overflowing, the row actions wrapping instead of pushing the row off
 *   the page. And at BOTH widths its own Workspace filter, with the "all" option, present and untouched:
 *   that filter is the reason this app is one panel and not one per project.
 *
 * Two harness rules this repo paid for, both applied here:
 *  - viewport AND `?width=` together (t-b24282): `?width=` alone narrows a div while `@media` still reads
 *    the 1280px browser viewport, so a breakpoint measured that way silently tests nothing;
 *  - a fixture with real VOLUME (the C5 lesson): a four-session fixture cannot show what a row grid, a
 *    five-column filter bar or a long `startCommand` do at the length a working machine produces.
 *
 * Prereq: `node esbuild.mjs` and `npm run preview:webview` in another shell.
 * Run: `node scripts/visual-qa/tmux-app-widths.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/485-d1";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const fixture = "volume";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

let bad = 0;
for (const w of widths) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 900 });
  // t-b24282 — the width goes to the harness once; the surface's DOM lives in the returned frame.
  const surface = await openPreview(page, { view: "inspector", fixture, width: w, height: 900, settleMs: 700 });

  const m = await surface.evaluate(() => {
    const de = document.documentElement;
    const root = document.querySelector(".insp-root");
    const scrolls = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      }
      return false;
    };
    // `de.clientWidth` is the page box; anything whose right edge escapes it, and which is not clipped
    // by a scrolling ancestor, is real horizontal overflow.
    const over = [...document.querySelectorAll(".insp-root *")]
      .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}`);
    const rowTop = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    const wsSelect = [...document.querySelectorAll(".filters select")].find(
      (s) => s.getAttribute("aria-label") === "Workspace",
    );
    const filters = document.querySelector(".filters");
    const filterRows = filters
      ? new Set([...filters.children].map((c) => Math.round(c.getBoundingClientRect().top))).size
      : 0;
    return {
      rendered: !!root,
      sessions: document.querySelectorAll(".sess").length,
      groups: document.querySelectorAll(".group").length,
      scrollW: de.scrollWidth,
      clientW: de.clientWidth,
      over: over.slice(0, 4),
      // the surface's OWN page pad — the thing that was Control's shell's a commit ago.
      padLeft: root ? getComputedStyle(root).paddingLeft : null,
      // the Workspace filter, with its "all" option: the reason this app is one panel, not one per project.
      workspaceFilter: wsSelect
        ? { present: true, options: [...wsSelect.options].map((o) => o.value) }
        : { present: false },
      filterRows,
      chromeTop: rowTop(".ds-page-chrome"),
      tabsTop: rowTop(".ds-tabs"),
      filtersTop: rowTop(".filters"),
    };
  });

  await page.screenshot({ path: `${outDir}/tmux-${fixture}-${w}.png`, fullPage: true });

  const noOverflow = m.scrollW <= m.clientW && m.over.length === 0;
  const hasScope = m.workspaceFilter.present && m.workspaceFilter.options.includes("all");
  const ok = m.rendered && m.sessions > 15 && noOverflow && hasScope;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} @${w} rendered=${m.rendered} sessions=${m.sessions} groups=${m.groups} ` +
      `scrollW=${m.scrollW} clientW=${m.clientW} pad=${m.padLeft} filterRows=${m.filterRows} ` +
      `wsFilter=${JSON.stringify(m.workspaceFilter)} chrome/tabs/filters=${m.chromeTop}/${m.tabsTop}/${m.filtersTop}` +
      (m.over.length ? ` over=${JSON.stringify(m.over)}` : ""),
  );
  await page.close();
}

// The Server tab is the other half of the screen and has its own grid, so it is measured too rather
// than assumed — at 360 a five-column metric grid is exactly the kind of thing that clips.
for (const w of widths) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 900 });
  const surface = await openPreview(page, { view: "inspector", fixture, width: w, height: 900, settleMs: 700 });
  await surface.evaluate(() => {
    const tab = [...document.querySelectorAll(".ds-tabs button, .ds-tabs [role=tab]")].find(
      (b) => b.textContent.trim() === "Server",
    );
    tab?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const m = await surface.evaluate(() => {
    const de = document.documentElement;
    const over = [...document.querySelectorAll(".server-panel *")].filter((e) => {
      for (let n = e; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return false;
      }
      return e.getBoundingClientRect().right > de.clientWidth + 0.5;
    }).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}`);
    return {
      rendered: !!document.querySelector(".server-panel"),
      metrics: document.querySelectorAll(".metric").length,
      scrollW: de.scrollWidth,
      clientW: de.clientWidth,
      over: over.slice(0, 4),
    };
  });
  await page.screenshot({ path: `${outDir}/tmux-server-${w}.png`, fullPage: true });
  const ok = m.rendered && m.metrics === 5 && m.scrollW <= m.clientW && m.over.length === 0;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} server@${w} rendered=${m.rendered} metrics=${m.metrics} ` +
      `scrollW=${m.scrollW} clientW=${m.clientW}` + (m.over.length ? ` over=${JSON.stringify(m.over)}` : ""),
  );
  await page.close();
}

await browser.close();
console.log(bad === 0 ? `\nVISUAL QA PASS — 4/4, screenshots in ${outDir}` : `\nVISUAL QA FAIL — ${bad}/4`);
process.exit(bad ? 1 : 0);
