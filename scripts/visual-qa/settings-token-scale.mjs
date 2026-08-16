/**
 * SDD 505 slice 8 (t-74639f) — the two-width visual pass for `settings` moving onto the slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement BEFORE the sheet was touched (an anchor written
 * afterwards only proves the screenshot matches itself):
 *
 *   The Settings page keeps the hierarchy it has today: the two-authority intro and the pair of
 *   scope cards (side-by-side at 880, stacked below 720), then the card-template composer, then the
 *   stacked blocks (global / idle / browser / companion / devices). Hints and body stay readable —
 *   they do not get the operator squeeze. The ONLY acceptable difference is that every
 *   padding/margin/gap becomes a step of the host ruler (2/4/6/8/10/12/16/20/24/32) and every type
 *   size a step of the ramp chosen by that element's role. Off-scale distances go to the nearest
 *   step; on a tie the host's own frequency wins (benchmark.md §2.4: 4 > 2 > 8 > 6 > 12 > 24 > 16 >
 *   10 > 32 > 20), so 14→12 and 18→16. 1px badge pad is distance, not stroke, so 1→2. Reading prose
 *   at 11px has no 11 on the reading ramp and must not tighten: it goes to --ds-reading-body3
 *   (13/20). The pairing code 18px goes to --ds-reading-headline2 (20), not 16 — 16 would tighten
 *   the one number a person copies. Nothing disappears, nothing starts wrapping that did not wrap,
 *   the 720px stack still stacks, paths still wrap. At 360 the scope cards are one column and no
 *   block overflows horizontally. At 880 the two scope cards stay two columns and the writes-to
 *   marker stays under the title, quieter than the hint.
 *
 * Density, chosen by role (not by file). Settings is more reading than operation; the owner named
 * two ramps so reading surfaces stay readable.
 *
 *   READING  intro, scope-hint, block-hint, block-body, pair-offer-code
 *   OPERATOR titles, paths, writes-to, disclosure, toggles, toggle-help, inputs, status, badges,
 *            device name/meta, pair labels/urls/candidates, card-region titles, errors, yaml,
 *            effect labels/values/projects
 *
 * The rounding rule was declared before it was applied, so it could not become taste.
 *
 * WHY THIS ONE FIXTURE: `default` is the only settings fixture and it already carries the intro,
 * both scope cards, the card-template composer, global settings, idle notify, the browser gate,
 * companion with a live device, and the device row. The ephemeral pair-offer card is a separate
 * host message and does not mount in this harness — its CSS still migrates; this pass cannot
 * photograph it.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is
 * the evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/settings-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-settings";
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
    await page.setViewport({ width: w, height: 1400 });
    const surface = await openPreview(page, {
      view: "settings",
      fixture,
      width: w,
      height: 1400,
      settleMs: 700,
      waitFor: "[data-testid='control-settings']",
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
      const scopes = document.querySelector(".ck-settings-scopes");
      const scopeCols = scopes ? getComputedStyle(scopes).gridTemplateColumns : null;
      return {
        counts: {
          scopes: document.querySelectorAll(".ck-settings-scope").length,
          blocks: document.querySelectorAll(".ck-settings-block").length,
          devices: document.querySelectorAll(".ck-device-row").length,
          badges: document.querySelectorAll(".ck-badge").length,
          pairOffer: document.querySelectorAll(".ck-pair-offer").length,
        },
        intro: box(".ck-settings-intro", ["font-size", "line-height", "margin-bottom"]),
        scopes: box(".ck-settings-scopes", ["gap", "margin-bottom", "grid-template-columns"]),
        scope: box(".ck-settings-scope", [...pad]),
        scopeTitle: box(".ck-settings-scope-title", ["font-size", "margin-bottom", "font-weight"]),
        scopeHint: box(".ck-settings-scope-hint", ["font-size", "line-height", "margin-bottom"]),
        scopePath: box(".ck-settings-scope-path", ["font-size", "margin-bottom"]),
        writesTo: box(".ck-settings-block-scope", ["font-size", "margin-top", "margin-bottom"]),
        blockTitle: box(".ck-settings-block-title", ["font-size", "margin-bottom"]),
        blockHint: box(".ck-settings-block-hint", ["font-size", "line-height", "margin-bottom"]),
        blockBody: box(".ck-settings-block-body", ["font-size", "line-height", "margin-bottom"]),
        toggle: box(".ck-settings-toggle", ["font-size", "gap", "margin-bottom"]),
        toggleHelp: box(".ck-settings-toggle-help", ["font-size", "margin-top"]),
        badge: box(".ck-badge", [...pad, "font-size"]),
        deviceRow: box(".ck-device-row", [...pad, "gap"]),
        deviceName: box(".ck-device-name", ["font-size"]),
        deviceMeta: box(".ck-device-meta", ["font-size", "gap", "margin-top"]),
        cardRegion: box(".ck-card-region", [...pad]),
        cardErrors: box(".ck-card-errors", ["font-size", "padding-left", "margin-top"]),
        cardHome: box(".ck-card-home", ["gap", "margin-top", "margin-bottom"]),
        scopeColumns: scopeCols,
        overflow: { scrollW: de.scrollWidth, clientW: de.clientWidth, over: over.slice(0, 8) },
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
    `${k.padEnd(16)} intro ${v.intro?.["font-size"]}/${v.intro?.["line-height"]}  hint ${v.blockHint?.["font-size"]}  cols ${v.scopeColumns}  overflow ${o.scrollW > o.clientW ? `YES ${o.scrollW}>${o.clientW} ${o.over.join(",")}` : "no"}`,
  );
}
