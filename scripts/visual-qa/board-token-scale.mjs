/**
 * SDD 505 slice 8 (t-c59cda) — the two-width visual pass for `board` moving onto the slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement BEFORE the sheet was touched (an anchor written
 * afterwards only proves the screenshot matches itself). Journalled on t-c59cda at 2026-08-16T01:38:23Z
 * as j-0a90dcd3e14f, before any CSS edit:
 *
 *   The Board keeps today's hierarchy: PageChrome + toolbar (workspace, search, agent filter,
 *   Awaiting you), optional spotlight/liveness banners, the validation strip, then the equal 300px
 *   columns of cards (author / kind+prio+attn+counts / title / id+assignee). The ONLY acceptable
 *   difference is that every padding/margin/gap becomes a step of the host ruler
 *   (2/4/6/8/10/12/16/20/24/32) and every label a step of the operator ramp (10/11/12/13), except
 *   the page title which stays 16 as --ds-reading-body1 (no 16 on the operator ramp; shrinking the
 *   chrome title 16→13 would be a redesign). Off-scale: 14→12 (col-body pad; 12/16 tie, 12 wins),
 *   5→4, 9/9.5→10, 1→2. Nothing disappears, cards stay 300px, titles still wrap inside the column,
 *   the 620px validation-close stack still stacks. At 880 the columns sit in a row. At 360 the
 *   board scrolls horizontally (overflow-x:auto, unchanged) and no card overflows its column.
 *
 * Density: ALL operator except .ds-page-chrome-title (reading-body1). Icons at 14px
 * (.more-item .codicon) stay 14 — icon size, no ramp role.
 *
 * Rounding rule, declared before it was applied (same as t-7cb9fe): every padding/margin/gap
 * literal goes to the NEAREST step of the ten; on a tie the step the HOST itself uses more in its
 * own already-migrated CSS wins (benchmark.md §2.4: 4>2>8>6>12>24>16>10>32>20).
 *
 * WHY THIS FIXTURE: `default` already carries the validation strip, every always-on column, a
 * dropped card, agent chips, priorities, assignees, attention, attachment count, and a spotlight
 * card. `volume` exists to prove column scroll height, which this slice does not change.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is
 * the evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/board-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-board";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const fixtures = ["default"];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = {};
for (const fixture of fixtures) {
  for (const w of widths) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 900 });
    const surface = await openPreview(page, {
      view: "board",
      fixture,
      width: w,
      height: 900,
      waitFor: ".mc-root",
      settleMs: 700,
    });

    const m = await surface.evaluate(() => {
      const de = document.documentElement;
      const box = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const out = {};
        for (const p of props) out[p] = cs.getPropertyValue(p);
        const r = el.getBoundingClientRect();
        out._rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
        return out;
      };
      const pad = ["padding-top", "padding-right", "padding-bottom", "padding-left"];
      const boardEl = document.querySelector(".board");
      const colOverflow = [...document.querySelectorAll(".card")].filter((el) => {
        const col = el.closest(".col");
        if (!col) return false;
        return el.getBoundingClientRect().right > col.getBoundingClientRect().right + 0.5;
      }).length;
      return {
        counts: {
          columns: document.querySelectorAll(".col").length,
          cards: document.querySelectorAll(".card").length,
          validations: document.querySelectorAll(".validation-pill").length,
          nextTags: document.querySelectorAll(".next-tag").length,
          prios: document.querySelectorAll(".prio").length,
        },
        chromeTitle: box(".ds-page-chrome-title", ["font-size", "line-height"]),
        headTools: box(".mc-head-tools", ["gap"]),
        search: box(".board-search", [...pad, "gap"]),
        searchIcon: box(".board-search .codicon-search", ["font-size"]),
        board: box(".board", [...pad, "gap"]),
        col: box(".col", ["width", "min-width", "max-width", "flex-basis"]),
        colHead: box(".col-head", [...pad, "gap"]),
        colCnt: box(".col-head .cnt", ["font-size"]),
        colBody: box(".col-body", [...pad, "gap"]),
        card: box(".card", pad),
        cardTitle: box(".card .title", ["font-size", "line-height"]),
        nextTag: box(".next-tag", ["font-size", "padding-left", "padding-right", "top"]),
        ref: box(".ref", ["font-size"]),
        author: box(".card-author", ["font-size"]),
        prio: box(".prio", ["font-size", "padding-left", "padding-right"]),
        kind: box(".kind", ["font-size", "padding-left", "padding-right"]),
        attach: box(".attach-count", ["font-size", "gap"]),
        attnIcon: box(".attn .codicon", ["font-size"]),
        whoBtn: box(".who-btn", ["gap"]),
        validationStrip: box(".validation-strip", [...pad, "gap", "min-height"]),
        validationPill: box(".validation-pill", [...pad, "font-size", "gap"]),
        validationSummary: box(".validation-summary", ["font-size", "gap"]),
        overflow: {
          scrollW: de.scrollWidth,
          clientW: de.clientWidth,
          boardScrollW: boardEl ? boardEl.scrollWidth : null,
          boardClientW: boardEl ? boardEl.clientWidth : null,
          cardOverflowsColumn: colOverflow,
        },
      };
    });

    report[`${fixture}@${w}`] = m;
    await page.screenshot({ path: `${outDir}/${fixture}-${w}.png`, fullPage: true });
    await page.close();
  }
}

writeFileSync(`${outDir}/measurements.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(`wrote ${fixtures.length * widths.length} screenshots + measurements.json to ${outDir}`);
for (const [k, v] of Object.entries(report)) {
  const o = v.overflow;
  console.log(
    `${k.padEnd(16)} title ${v.chromeTitle?.["font-size"]}  card-title ${v.cardTitle?.["font-size"]}  col-body-pt ${v.colBody?.["padding-top"]}  col-w ${v.col?.width}  card-overflow-col ${o.cardOverflowsColumn}  board-scroll ${o.boardScrollW}>${o.boardClientW}`,
  );
}
