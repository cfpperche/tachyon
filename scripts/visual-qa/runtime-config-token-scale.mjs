/**
 * SDD 505 slice 8 (t-226e8a) — the two-width visual pass for `runtime-config` moving onto the
 * slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement BEFORE the sheet was touched (an anchor written
 * afterwards only proves the screenshot matches itself). Journalled on t-226e8a at 2026-08-16T00:41:24Z
 * as j-f8d6e7407c2a, before any CSS edit:
 *
 *   The Runtime Config editor keeps the hierarchy and the reading it has today: PageChrome (title +
 *   hint + Measured editor badge), the four-field toolbar (runtime picker + scope segments + source
 *   path + Open file), the impact strip with agent badges, global warnings, the actions bar (state +
 *   Cancel/Save), and the card grid (editable settings | MCP servers, Other keys full-bleed below).
 *   The ONLY acceptable difference is that every distance becomes a step of the host's ruler
 *   (2/4/6/8/10/12/16/20/24/32) and every label a step of the operator ramp (10/11/12/13) — in
 *   practice, shifts of at most 2px wherever a half-step (3,5,7,9) or the 1px the three references
 *   call stroke lived. Nothing disappears, nothing starts wrapping that did not wrap, nothing
 *   touches anything, nothing overflows horizontally. At 880: toolbar in four columns, two-card
 *   grid + Other full-bleed. At 360: the @media (max-width: 850px) stacks toolbar and grid to one
 *   column; picker, segments and lists stay inside the viewport and ellipsis instead of bursting.
 *   One change is declared UP FRONT because it exceeds 2px and is therefore the only one the owner
 *   should find by looking at space: MCP item / empty indent (padding-left 28px and padding 7px 28px)
 *   becomes 24px (size240; 24/32 tie, host uses 24 more). 9px type becomes 10px (operator-label3).
 *   Anything else moving by more than ±2px is a defect of this slice, not the scale.
 *
 * Rounding rule, declared before it was applied (same as t-7cb9fe): every padding/margin/gap literal
 * goes to the NEAREST step of the ten; on a tie the step the HOST itself uses more in its own
 * already-migrated CSS wins (benchmark.md §2.4: 4>2>8>6>12>24>16>10>32>20). So 3→4, 5→4, 7→8, 9→8,
 * 28→24, 1px→2px.
 *
 * WHY THIS FIXTURE: `default` is the only named fixture this surface has, and it is the fullest
 * default screen (toolbar + impact + global warning + three editable settings + one MCP server +
 * Other keys + hidden-records rail). Inventing a second fixture to photograph would be a fiction.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is the
 * evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/runtime-config-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-runtime-config";
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
    await page.setViewport({ width: w, height: 1200 });
    const surface = await openPreview(page, {
      view: "runtime-config",
      fixture,
      width: w,
      height: 1200,
      waitFor: "[data-testid='control-runtime-config']",
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
      const pad = ["padding-top", "padding-right", "padding-bottom", "padding-left"];
      const colour = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return [cs.color, cs.backgroundColor, cs.borderTopColor].join(" / ");
      };
      return {
        colours: {
          toolbar: colour(".rcp-toolbar"),
          card: colour(".rcp-card"),
          warning: colour(".rcp-global-warning"),
          source: colour(".rcp-source-value"),
          settingCode: colour(".rcp-setting code"),
          capabilityHead: colour(".rcp-capability-group-head"),
          runtimeState: colour(".rcp-runtime-state"),
          otherCode: colour(".rcp-other-preview code"),
          eyebrow: colour(".rcp-eyebrow"),
          h2: colour(".rcp-card-head h2"),
        },
        counts: {
          toolbarFields: document.querySelectorAll(".rcp-toolbar-field").length,
          cards: document.querySelectorAll(".rcp-card").length,
          settings: document.querySelectorAll(".rcp-setting").length,
          capabilities: document.querySelectorAll(".rcp-capability-item").length,
          warnings: document.querySelectorAll(".rcp-global-warning").length,
          otherKeys: document.querySelectorAll(".rcp-other-preview code").length,
          badges: document.querySelectorAll(".ds-badge").length,
        },
        toolbar: box(".rcp-toolbar", [...pad, "gap"]),
        eyebrow: box(".rcp-eyebrow", ["font-size", "font-weight", "letter-spacing"]),
        runtimeSelect: box(".rcp-runtime-select", [...pad, "gap", "font-size", "min-height"]),
        segmented: box(".rcp-segmented", ["min-height"]),
        segmentedBtn: box(".rcp-segmented button", ["font-size"]),
        segmentedIcon: box(".rcp-segmented .codicon", ["font-size", "margin-right"]),
        toolbarValue: box(".rcp-toolbar-value", [...pad, "font-size", "min-height"]),
        impact: box(".rcp-impact", [...pad, "gap", "margin-top", "font-size"]),
        warning: box(".rcp-global-warning", [...pad, "margin-top", "font-size", "border-left-width"]),
        actionsBar: box(".rcp-actions-bar", [...pad, "gap", "margin-top"]),
        grid: box(".rcp-grid", ["gap", "margin-top"]),
        card: box(".rcp-card", pad),
        cardHead: box(".rcp-card-head", ["gap", "margin-bottom"]),
        cardH2: box(".rcp-card-head h2", ["font-size", "margin-top"]),
        cardP: box(".rcp-card-head p", ["font-size", "margin-top"]),
        setting: box(".rcp-setting", [...pad, "gap", "font-size"]),
        settingList: box(".rcp-setting-list", ["gap"]),
        capabilityItem: box(".rcp-capability-item", [...pad, "gap", "min-height"]),
        capabilityStrong: box(".rcp-capability-item strong", ["font-size"]),
        capabilitySpan: box(".rcp-capability-item > div > span", ["font-size"]),
        runtimeState: box(".rcp-runtime-state", [...pad, "margin-bottom", "font-size"]),
        otherCode: box(".rcp-other-preview code", [...pad, "font-size"]),
        overflow: { scrollW: de.scrollWidth, clientW: de.clientWidth, over: over.slice(0, 8) },
        columns: {
          toolbar: getComputedStyle(document.querySelector(".rcp-toolbar")).gridTemplateColumns,
          grid: getComputedStyle(document.querySelector(".rcp-grid")).gridTemplateColumns,
        },
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
  console.log(
    `${k.padEnd(16)} toolbar-gap ${v.toolbar?.gap}  setting-pad ${v.setting ? [v.setting["padding-top"], v.setting["padding-left"]].join("/") : "—"}  cap-pl ${v.capabilityItem?.["padding-left"]}  eyebrow ${v.eyebrow?.["font-size"]}  overflow ${o.scrollW > o.clientW ? `YES ${o.scrollW}>${o.clientW} ${o.over.join(",")}` : "no"}  cols ${v.columns?.grid}`,
  );
}
