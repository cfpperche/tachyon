/**
 * SDD 505 slice 8 (t-cb36a4) — the two-width visual pass for `rich-doc` moving onto the slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement BEFORE the sheet was touched (an anchor written
 * afterwards only proves the screenshot matches itself). Journalled on t-cb36a4 at 2026-08-16T01:59:07Z
 * as j-6c5547a502aa, before any CSS edit:
 *
 *   This is a READING surface — the document is what a person reads. The owner named two densities
 *   so squeezing reading would not happen. The Pin/Task studio that mounts rich-doc keeps today's
 *   hierarchy: eyebrow + document title, formatting toolbar (raw buttons, not the kit), editor
 *   body, visuals column (drop zone + "Visuals · N"). The ONLY acceptable difference is that every
 *   padding/margin/gap becomes a step of the host ruler (2/4/6/8/10/12/16/20/24/32) and every type
 *   size a step of the ramp chosen by that element's role. Editor 14px has no 14 on the reading
 *   ramp and must not tighten to 13 → --ds-reading-body1 (16/24). Title is already 20 →
 *   --ds-reading-headline2 (20/24). Headings keep inheriting body size with line-height 1.25.
 *   Off-scale: 3→4, 14→12 (heading margin), 22→24 (editor pad). Nothing disappears, nothing starts
 *   wrapping that did not wrap, the 820px stack still stacks. At 880 the editor and visuals sit in
 *   the studio grid. At 360 the existing @media (max-width:820px) stacks bar and visuals; no
 *   editor/toolbar overflows horizontally. The 18 raw toolbar/slash/att/drop buttons stay raw.
 *
 * Density by role (not by file):
 *   READING  .rich-doc-editor (body + inherited headings), .rd-title
 *   OPERATOR .rd-eyebrow, .rd-att-head, .rd-att-actions button, .rd-att-annotated-badge .codicon,
 *            toolbar/slash chrome
 *
 * Rounding rule, declared before it was applied (same as t-7cb9fe): nearest step; tie-break
 * 4>2>8>6>12>24>16>10>32>20. 1px is stroke, never distance.
 *
 * WHY THIS FIXTURE: `pin-preview` `edit` is the shipped door that mounts the real rich-doc
 * editor (toolbar + editor + visuals) through Pin Studio. The default pin-preview fixture is
 * read-only pin-preview.css, which this card does not touch.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is
 * the evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/rich-doc-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-rich-doc";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const fixtures = ["edit"];

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
      waitFor: ".rich-doc-editor, .rd-toolbar",
      settleMs: 900,
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
      const visuals = document.querySelector(".rd-visuals");
      const toolbar = document.querySelector(".rd-toolbar");
      const editor = document.querySelector(".rich-doc-editor");
      return {
        counts: {
          toolbarButtons: document.querySelectorAll(".rd-toolbar button").length,
          slashButtons: document.querySelectorAll(".rd-slash button").length,
          dropButtons: document.querySelectorAll("button.rd-drop").length,
          attActionButtons: document.querySelectorAll(".rd-att-actions button").length,
          paragraphs: document.querySelectorAll(".rich-doc-editor p").length,
        },
        eyebrow: box(".rd-eyebrow", ["font-size", "line-height", "margin-bottom", "letter-spacing"]),
        title: box(".rd-title", ["font-size", "line-height", "font-family", "font-weight"]),
        toolbar: box(".rd-toolbar", [...pad, "gap"]),
        toolbarBtn: box(".rd-toolbar button", ["min-width", "height", "gap", "font-size"]),
        editor: box(".rich-doc-editor", [...pad, "font-size", "line-height", "font-family"]),
        editorP: box(".rich-doc-editor p", ["margin-top", "margin-bottom", "font-size", "line-height"]),
        visuals: box(".rd-visuals", [...pad, "border-left-width", "border-top-width"]),
        drop: box(".rd-drop", [...pad, "gap", "min-height"]),
        attHead: box(".rd-att-head", ["font-size", "margin-top", "margin-bottom"]),
        overflow: {
          scrollW: de.scrollWidth,
          clientW: de.clientWidth,
          over: over.slice(0, 8),
          visualsTop: visuals ? Math.round(visuals.getBoundingClientRect().top) : null,
          toolbarBottom: toolbar ? Math.round(toolbar.getBoundingClientRect().bottom) : null,
          editorTop: editor ? Math.round(editor.getBoundingClientRect().top) : null,
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
  console.log(
    `${k.padEnd(16)} title ${v.title?.["font-size"]}  editor ${v.editor?.["font-size"]}/${v.editor?.["line-height"]}  pad-y ${v.editor?.["padding-top"]}  toolbar-btns ${v.counts?.toolbarButtons}  over ${v.overflow?.over?.length ?? 0}`,
  );
}
