/**
 * SDD 505 slice 8 (t-7cb9fe) — the two-width visual pass for `activity` moving onto the slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement BEFORE the sheet was touched (an anchor written
 * afterwards only proves the screenshot matches itself — five Design Mode slices passed green that way):
 *
 *   The activity transcript keeps the hierarchy and the reading it has today: the sticky header
 *   (counters + search + type filter + the terminal escape hatch), human bubbles right and agent bubbles
 *   left with the reading column at ~80% of the width, compact tool lines pinned left, the day separator
 *   and the compaction rule crossing the full width. The ONLY acceptable difference is that every
 *   distance becomes a step of the host's ruler (2/4/6/8/10/12/16/20/24/32) and every label a step of the
 *   operator ramp (10/11/12/13) — in practice, shifts of at most 2px wherever a half-step (3,5,7,9,11,14,
 *   18,22) lived. Nothing disappears, nothing starts wrapping that did not wrap, nothing touches anything,
 *   nothing overflows horizontally. At 360: the header still wraps without clipping the search, bubbles
 *   stay inside the viewport, tool lines still ellipsis instead of bursting. At 880: the share actions stay
 *   in the bubble's top-right corner and the type menu stays anchored to the right of its button. Two
 *   changes are declared UP FRONT because they exceed 2px and are therefore the only ones the owner should
 *   find by looking: `.msg .bubble` padding-right 38px→32px (the gap reserved for the share button, which
 *   measures 22px plus a 4px inset) and `.degrade` padding 48px→32px. Anything else moving by more than
 *   ±2px is a defect of this slice, not the scale.
 *
 * The rounding rule was declared before it was applied, so it could not become taste: every
 * padding/margin/gap literal goes to the NEAREST step of the ten; on a tie — and nearly all of them are
 * ties — the step the HOST itself uses more in its own already-migrated CSS wins (benchmark.md §2.4:
 * 4px 139 > 2px 69 > 8px 63 > 6px 38 > 12px 27 > 24px 20 > 16px 14 > 10px 11 > 32px 10 > 20px 4).
 *
 * WHY THESE FOUR FIXTURES: `default` is the fullest transcript this surface has (bubbles both sides, tool
 * lines, thinking blocks, code); `interrupted` is the one that renders the compaction rule and its warn
 * tone, which is where a colour token swap would show; `grok-feed` is a second captured host VM, so the
 * two are not one screen photographed twice; `mermaid-nav` carries the block chrome that co-loads from a
 * shared sheet, which is the neighbour this slice must NOT regress.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is the
 * evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/activity-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-activity";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const fixtures = ["default", "interrupted", "grok-feed", "mermaid-nav"];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = {};
for (const fixture of fixtures) {
  for (const w of widths) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 1000 });
    const surface = await openPreview(page, { view: "activity", fixture, width: w, height: 1000, settleMs: 700 });

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
      const scrolls = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
        }
        return false;
      };
      const over = [...document.querySelectorAll("body *")]
        .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}`);
      const pad = ["padding-top", "padding-right", "padding-bottom", "padding-left"];
      // colour is read too, and on purpose: this slice swaps direct theme refs for the token layer's
      // roles, so a hue that moves is either the role disagreeing with the old ref (a finding to
      // report) or a wrong token (a defect). Reasoning about the fallback chains would have missed it.
      const colour = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return [cs.color, cs.backgroundColor, cs.borderTopColor].join(" / ");
      };
      return {
        colours: {
          bubbleUser: colour(".msg.user .bubble"),
          bubbleAgent: colour(".msg.agent .bubble"),
          chrome: colour(".activity-chrome"),
          aline: colour(".aline"),
          cfull: colour(".cfull"),
          daysep: colour(".daysep span"),
          boundary: colour(".boundary"),
          boundaryInterrupted: colour(".boundary.interrupted"),
          stale: colour(".stale"),
          badgeWarn: colour(".ds-badge.warn"),
          mdCode: colour(".md code"),
          mdPre: colour(".md pre"),
          searchInput: colour(".head .search"),
          typeBtn: colour(".type-filter-btn"),
          link: colour(".aline .flink"),
        },
        counts: {
          msg: document.querySelectorAll(".msg").length,
          bubble: document.querySelectorAll(".bubble").length,
          aline: document.querySelectorAll(".aline").length,
          think: document.querySelectorAll(".think").length,
          codeblock: document.querySelectorAll(".codeblock").length,
          boundary: document.querySelectorAll(".boundary").length,
          daysep: document.querySelectorAll(".daysep").length,
          capnote: document.querySelectorAll(".capnote").length,
          mermaid: document.querySelectorAll(".mmd-block, .mermaid").length,
        },
        chrome: box(".activity-chrome", [...pad, "margin-bottom"]),
        feed: box(".feed", [...pad, "gap"]),
        bubble: box(".bubble", [...pad, "border-radius", "line-height"]),
        btime: box(".btime", ["font-size", "margin-top"]),
        aline: box(".aline", [...pad, "gap", "font-size"]),
        alineIcon: box(".aline .codicon", ["font-size"]),
        cfull: box(".cfull", [...pad, "margin-left", "font-size", "line-height"]),
        thinkBody: box(".think-body", [...pad, "margin-left", "font-size"]),
        thinkToggle: box(".think-toggle", ["font-size", "gap"]),
        boundary: box(".boundary", ["gap", "margin-top", "font-size"]),
        daysep: box(".daysep span", [...pad, "font-size", "border-radius"]),
        capnote: box(".capnote", [...pad, "gap", "font-size"]),
        mdP: box(".md p", ["margin-bottom", "font-size"]),
        mdPre: box(".md pre", [...pad, "font-size"]),
        mdCode: box(".md code", ["padding-left", "font-size"]),
        shareTrigger: box(".share-trigger", ["width", "height", "border-radius"]),
        overflow: { scrollW: de.scrollWidth, clientW: de.clientWidth, over: over.slice(0, 6) },
        sample: (document.querySelector(".btext")?.textContent ?? "").slice(0, 60),
      };
    });

    report[`${fixture}@${w}`] = m;
    await page.screenshot({ path: `${outDir}/${fixture}-${w}.png`, fullPage: false });
    await page.close();
  }
}

writeFileSync(`${outDir}/measurements.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(`wrote ${fixtures.length * widths.length} screenshots + measurements.json to ${outDir}`);
for (const [k, v] of Object.entries(report)) {
  const o = v.overflow;
  console.log(`${k.padEnd(22)} bubble-pad ${v.bubble ? Object.values(v.bubble).slice(0, 4).join("/") : "—"}  feed-gap ${v.feed?.gap}  aline-fs ${v.aline?.["font-size"]}  overflow ${o.scrollW > o.clientW ? `YES ${o.scrollW}>${o.clientW} ${o.over.join(",")}` : "no"}`);
}
