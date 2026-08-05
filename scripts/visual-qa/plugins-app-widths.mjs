/**
 * SDD 485 D2 — the two-width visual pass for Plugins as a standalone app.
 *
 * ANCHOR, written from the task's problem statement BEFORE the surface was measured (an anchor written
 * afterwards only proves the screenshot matches itself):
 *
 *   Plugins must arrive as a first-class editor tab showing the SAME installed list it showed inside
 *   Control — nothing gained and nothing lost by the move. At 880: the page chrome and its three actions
 *   on one row, the install-by-source bar and the Installed/Marketplace tabs below it, the filter/sort
 *   toolbar on ONE row, and each card reading name · version · status badge · actions across the top with
 *   its provenance and runtime pills beneath — all of it inside the surface's own single page pad rather
 *   than doubled or absent where Control's shell used to be. At 360: usable rather than clipping, with
 *   `plugins.css`'s own `@media (max-width: 720px)` firing — the toolbar collapsing to one column and the
 *   card actions moving to a full-width row — and nothing overflowing the page horizontally. And at BOTH
 *   widths the card states t-4e5f11 built must read exactly as they did: "up to date", "update available ·
 *   vX" beside an Update button, and "source changed · still vX" beside a REAPPLY button — that last pair
 *   is the whole point of that task, and a migration is exactly where a badge and its verb quietly stop
 *   agreeing.
 *
 * Two harness rules this repo paid for, both applied here:
 *  - the width goes to the HARNESS (t-b24282). It used to narrow a div while `@media` kept reading the
 *    1280px browser window, so a breakpoint measured that way silently tested nothing; the frame is an
 *    iframe now, so one `?width=` is the surface's own viewport. It matters on THIS surface for real —
 *    `plugins.css` carries a `@media (max-width: 720px)` block;
 *  - measure the states the recent work created, on the fixtures that already exist (`update-available`,
 *    `source-changed`), rather than inventing a fiction to photograph.
 *
 * On the FOURTH state: `deriveUpdateCheck` maps a downgrade to `up-to-date` on the card, deliberately —
 * a source that resolves LOWER offers nothing to update to, and saying "update available · v0.1.0" would
 * be a lie. Its distinct treatment (force-gated confirm + a warning) lives in the consent drawer, which
 * has never been a harness fixture in Control either. So three card renderings cover the four states, and
 * `default` is the one that stands for both "up to date" and "downgrade".
 *
 * Prereq: `node esbuild.mjs` and `npm run preview:webview` in another shell.
 * Run: `node scripts/visual-qa/plugins-app-widths.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { openPreview } from "./preview-surface.mjs";

const outDir = process.argv[2] ?? ".vqa/485-d2";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
/** each fixture with the card state it exists to show, and the badge/action that proves it rendered. */
const cases = [
  { fixture: "default", badge: null, plugin: null, note: "up to date (and downgrade, which renders the same)" },
  { fixture: "update-available", badge: "update available · v0.2.0", plugin: "visual-qa", action: "Update", note: "labeled version bump" },
  { fixture: "source-changed", badge: "source changed · still v2.0.1", plugin: "secrets-guard", action: "Reapply", note: "same version, different bytes" },
  { fixture: "runtime-gap", badge: null, plugin: null, note: "the t-fb216a coverage notice, which wraps at 360" },
];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

let bad = 0;
let ran = 0;
for (const c of cases) {
  for (const w of widths) {
    ran += 1;
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 900 });
    const surface = await openPreview(page, { view: "plugins", fixture: c.fixture, width: w, height: 900, settleMs: 700 });

    const m = await surface.evaluate((expect) => {
      const de = document.documentElement;
      const root = document.querySelector(".ck-plugins-root");
      const scrolls = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
        }
        return false;
      };
      // `de.clientWidth` is the page box; anything whose right edge escapes it, and which is not clipped
      // by a scrolling ancestor, is real horizontal overflow.
      const over = [...document.querySelectorAll(".ck-plugins-root *")]
        .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}`);
      const cards = [...document.querySelectorAll(".ds-card")];
      const cardOf = (name) => cards.find((el) => el.querySelector(".pname")?.textContent?.trim() === name);
      const target = expect.plugin ? cardOf(expect.plugin) : undefined;
      const rowTop = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      };
      const toolbar = document.querySelector(".installed-toolbar");
      // how many visual ROWS the toolbar's three controls occupy: 1 at 880, 3 once the 720px block fires.
      const toolbarRows = toolbar
        ? new Set([...toolbar.children].map((c) => Math.round(c.getBoundingClientRect().top))).size
        : 0;
      const chrome = document.querySelector(".ds-page-chrome");
      const chromeActionRows = chrome
        ? new Set([...chrome.querySelectorAll(".ds-page-chrome-actions > *")].map((c) => Math.round(c.getBoundingClientRect().top))).size
        : 0;
      return {
        rendered: !!root,
        cards: cards.length,
        // the surface's OWN page pad — the thing that was cockpit.css's a commit ago.
        padLeft: root ? getComputedStyle(root).paddingLeft : null,
        padTop: root ? getComputedStyle(root).paddingTop : null,
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        over: over.slice(0, 4),
        toolbarRows,
        toolbarCols: toolbar ? getComputedStyle(toolbar).gridTemplateColumns.split(" ").length : 0,
        chromeActionRows,
        chromeTop: rowTop(".ds-page-chrome"),
        addbarTop: rowTop(".addbar"),
        tabsTop: rowTop(".ds-tabs"),
        badge: target ? target.querySelector(".ds-badge")?.textContent?.trim() ?? null : null,
        actions: target ? [...target.querySelectorAll(".card-actions button")].map((b) => b.textContent.trim()).filter(Boolean) : [],
        // t-fb216a's coverage notice, the other card variant recent work added.
        coverageNotices: document.querySelectorAll(".pgap").length,
      };
    }, c);

    await page.screenshot({ path: `${outDir}/plugins-${c.fixture}-${w}.png`, fullPage: true });

    const noOverflow = m.scrollW <= m.clientW && m.over.length === 0;
    const padded = m.padLeft && m.padLeft !== "0px" && m.padTop && m.padTop !== "0px";
    const badgeOk = !c.badge || m.badge === c.badge;
    const actionOk = !c.action || m.actions.includes(c.action);
    const ok = m.rendered && m.cards > 0 && noOverflow && padded && badgeOk && actionOk;
    if (!ok) bad += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${c.fixture}@${w} cards=${m.cards} pad=${m.padTop}/${m.padLeft} ` +
        `scrollW=${m.scrollW} clientW=${m.clientW} toolbarRows=${m.toolbarRows} toolbarCols=${m.toolbarCols} ` +
        `chromeActionRows=${m.chromeActionRows} chrome/addbar/tabs=${m.chromeTop}/${m.addbarTop}/${m.tabsTop} ` +
        `notices=${m.coverageNotices}` +
        (c.plugin ? ` ${c.plugin}: badge=${JSON.stringify(m.badge)} actions=${JSON.stringify(m.actions)}` : "") +
        (m.over.length ? ` over=${JSON.stringify(m.over)}` : ""),
    );
    await page.close();
  }
}

await browser.close();
console.log(bad === 0 ? `\nVISUAL QA PASS — ${ran}/${ran}, screenshots in ${outDir}` : `\nVISUAL QA FAIL — ${bad}/${ran}`);
process.exit(bad ? 1 : 0);
