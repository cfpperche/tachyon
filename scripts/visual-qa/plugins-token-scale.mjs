/**
 * SDD 505 slice 8 (t-5b06ba) — the two-width visual pass for `plugins` moving onto the slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement (journalled on t-5b06ba as j-9c6868a62448 before
 * the sheet was rewritten). An anchor written afterwards only proves the screenshot matches itself:
 *
 *   Plugins is an OPERATOR surface — install, consent, apply — not a reading surface. The installed
 *   list keeps today's hierarchy: PageChrome (title + workspace-runtimes hint + Check/Repair/Refresh),
 *   the install-by-source bar, Installed/Marketplace tabs, the filter/sort/count toolbar, then one
 *   card per plugin (name · version · status · actions, provenance + runtime pills beneath, optional
 *   coverage notice / contribution rows). t-4aac93's Open button (and the multi-surface dropdown)
 *   stays a kit Button / KitDropdown — this slice does not swap components. The ONLY acceptable
 *   difference is that every padding/margin/gap becomes a step of the host ruler
 *   (2/4/6/8/10/12/16/20/24/32) and every type size a step of the operator ramp by ROLE
 *   (label3/2/1 = 10/11/12, body1 = 13). Card/drawer title (was 14) → body1; banner/kv/ack (was
 *   12.5) → label1; dim metadata → label2. Nothing disappears, nothing starts wrapping that did
 *   not wrap. At 880: chrome actions and toolbar on one row; card name/actions on one row. At 360:
 *   plugins.css `@media (max-width: 720px)` stacks the toolbar and full-width card actions; no
 *   horizontal overflow. The runtime-gap notice still wraps instead of clipping.
 *
 * Rounding rule, declared before it was applied (same as t-7cb9fe): nearest step; tie-break
 * 4>2>8>6>12>24>16>10>32>20. So 3→4, 5→4, 7→8, 9→8, 14→12, 40→32, 1px→2px.
 *
 * WHY THESE FIXTURES: `default` is the steady installed list (the 29-distance sheet's main page).
 * `runtime-gap` is the coverage notice that the existing 360 measurement already cares about.
 * `multi-surface` is today's Open / dropdown (t-4aac93) — a scale migration must not hide it.
 * Consent drawer has no harness fixture; its distances still snap on the same sheet.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is
 * the evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/plugins-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-plugins";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const fixtures = ["default", "runtime-gap", "multi-surface"];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = {};
for (const fixture of fixtures) {
  for (const w of widths) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 1200 });
    const surface = await openPreview(page, {
      view: "plugins",
      fixture,
      width: w,
      height: 1200,
      waitFor: ".ck-plugins-root",
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
      const scrolls = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
        }
        return false;
      };
      const over = [...document.querySelectorAll(".ck-plugins-root *")]
        .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`);
      const toolbar = document.querySelector(".installed-toolbar");
      const toolbarRows = toolbar
        ? new Set([...toolbar.children].map((c) => Math.round(c.getBoundingClientRect().top))).size
        : 0;
      return {
        counts: {
          cards: document.querySelectorAll(".ds-card").length,
          pills: document.querySelectorAll(".rt").length,
          notices: document.querySelectorAll(".pgap").length,
          openButtons: [...document.querySelectorAll(".card-actions button")].filter((b) => b.textContent.trim() === "Open").length,
          kitButtons: document.querySelectorAll("button.ds-btn").length,
        },
        addbar: box(".addbar", [...pad, "gap"]),
        toolbar: box(".installed-toolbar", [...pad, "gap"]),
        list: box(".list", [...pad, "gap"]),
        cardTop: box(".card-top", ["gap"]),
        pname: box(".pname", ["font-size", "font-weight"]),
        pver: box(".pver", ["font-size"]),
        pmeta: box(".pmeta", ["font-size", "margin-top", "gap"]),
        rt: box(".rt", [...pad, "font-size"]),
        pgap: box(".pgap", [...pad, "margin-top", "font-size"]),
        toolbarCount: box(".toolbar-count", ["font-size"]),
        toolbarRows,
        toolbarCols: toolbar ? getComputedStyle(toolbar).gridTemplateColumns.split(" ").length : 0,
        overflow: {
          scrollW: de.scrollWidth,
          clientW: de.clientWidth,
          over: over.slice(0, 8),
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
    `${k.padEnd(24)} pname ${v.pname?.["font-size"]}  list-gap ${v.list?.gap}  pmeta ${v.pmeta?.["font-size"]}/${v.pmeta?.["margin-top"]}  overflow ${o.scrollW > o.clientW ? `YES ${o.scrollW}>${o.clientW} ${o.over.join(",")}` : "no"}  toolbarRows=${v.toolbarRows}`,
  );
}
