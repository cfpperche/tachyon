/**
 * SDD 505 slice 8 (t-0f7068) — the two-width visual pass for `pin-preview` moving onto the slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement BEFORE the sheet was touched (an anchor written
 * afterwards only proves the screenshot matches itself). Journalled on t-0f7068 at 2026-08-16T02:22:54Z
 * as j-b57f4b0cda99, before any CSS edit:
 *
 *   This is a READING surface — the pin body is preview of content. The owner named two densities
 *   so squeezing reading would not happen. The read-only Pin Preview keeps today's hierarchy:
 *   kicker, title, meta pills/tags, the body (flattened paragraphs or StaticDoc), then Visuals.
 *   The ONLY acceptable difference is that every padding/margin/gap becomes a step of the host
 *   ruler (2/4/6/8/10/12/16/20/24/32) and every type size a step of the ramp chosen by ROLE.
 *   Body 14px has no 14 on the reading ramp and must not tighten to 13 → --ds-reading-body1
 *   (16/24), the same role .rich-doc-editor now uses. Title 22 → --ds-reading-headline2 (20/24).
 *   Headings inside .body keep inheriting body size with line-height 1.25. Nothing disappears,
 *   nothing starts wrapping that did not wrap. At 880 the page is a single 880-capped column.
 *   At 360 the existing @media (max-width:540px) tightens main pad and visual thumbs; no
 *   horizontal overflow. The kit Edit pin button stays the kit button.
 *
 * Density by role (not by file):
 *   READING  .body (plain <p> and StaticDoc), h1 (pin title)
 *   OPERATOR .kicker, .meta/.pill/.tag, .visuals h2, .visual span
 *
 * COPY vs REFERENCE: reference the same reading role token. Sharing .rich-doc-editor is wrong
 * (editor chrome). Adding .body to rich-doc.css would leak (t-61189b). Copied numbers are what
 * diverged today.
 *
 * Rounding rule, declared before it was applied (same as t-7cb9fe): nearest step; tie-break
 * 4>2>8>6>12>24>16>10>32>20. 1px pill pad is distance, not stroke → 2.
 *
 * WHY THESE FIXTURES: `default` is chrome + flattened body + visuals (the full read-only page).
 * `with-image` is the StaticDoc door that copies the editor's element rules. `edit` mounts Pin
 * Studio / rich-doc, which this card does not touch.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is
 * the evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/pin-preview-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-pin-preview";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const fixtures = ["default", "with-image"];

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
      view: "pin-preview",
      fixture,
      width: w,
      height: 1200,
      waitFor: "main .body",
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
      const over = [...document.querySelectorAll("body *")]
        .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`);
      return {
        counts: {
          paragraphs: document.querySelectorAll(".body p").length,
          images: document.querySelectorAll(".body img").length,
          visuals: document.querySelectorAll(".visual").length,
          pills: document.querySelectorAll(".pill").length,
          tags: document.querySelectorAll(".tag").length,
          rawButtons: document.querySelectorAll("button:not(.ds-btn)").length,
          kitButtons: document.querySelectorAll("button.ds-btn").length,
        },
        kicker: box(".kicker", ["font-size", "line-height", "letter-spacing"]),
        title: box("header h1", ["font-size", "line-height", "margin-top", "font-weight"]),
        meta: box(".meta", ["font-size", "gap", "margin-top"]),
        pill: box(".pill", [...pad, "font-size", "line-height"]),
        body: box(".body", [...pad, "font-size", "line-height", "font-family"]),
        bodyP: box(".body p", ["margin-top", "margin-bottom", "font-size", "line-height"]),
        bodyImg: box(".body img", ["margin-top", "margin-bottom", "max-width"]),
        visuals: box(".visuals", ["margin-top", "padding-top"]),
        visualsHead: box(".visuals h2", ["font-size", "margin-bottom", "letter-spacing"]),
        visual: box(".visual", ["gap", "padding-top", "padding-bottom", "grid-template-columns"]),
        visualThumb: box(".visual img, .missing", ["width", "height"]),
        visualMeta: box(".visual span", ["font-size"]),
        main: box("main", [...pad, "max-width"]),
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
    `${k.padEnd(20)} title ${v.title?.["font-size"]}/${v.title?.["line-height"]}  body ${v.body?.["font-size"]}/${v.body?.["line-height"]}  kicker ${v.kicker?.["font-size"]}  overflow ${o.scrollW > o.clientW ? `YES ${o.scrollW}>${o.clientW} ${o.over.join(",")}` : "no"}`,
  );
}
