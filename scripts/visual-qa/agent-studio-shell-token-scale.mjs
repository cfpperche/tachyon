/**
 * SDD 505 slice 8 (t-c59cda) — the two-width visual pass for `agent-studio-shell` moving onto the
 * slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement BEFORE the sheet was touched (an anchor written
 * afterwards only proves the screenshot matches itself). Journalled on t-c59cda at 2026-08-16T01:38:23Z
 * as j-0a90dcd3e14f, before any CSS edit:
 *
 *   The studio keeps today's hierarchy: identity/lifecycle card, readiness, ownership, provenance
 *   sources, bindings, native-config table, form fields, hints, and (forget-plan) the 3-column step
 *   list. The ONLY acceptable difference is distances on the ruler (2/4/6/8/10/12/16/20/24/32) and
 *   type on the ramp chosen by ROLE. The two inline margin-top:12px become size120. 1px badge pad
 *   → 2. At 880 the compact grids stay 2/3 columns. At 360 (below 720/560) they stack to one column;
 *   fields stay inside the viewport; forget-plan steps stack (existing @media). Nothing disappears,
 *   nothing starts wrapping that did not wrap.
 *
 * Density by role (not by file):
 *   READING  .hint, .ash-native-config-risk, .ash-native-config-empty, .ash-runtime-readiness,
 *            .ash-forget-plan-pending, .ash-forget-plan-step-detail/.resolution,
 *            .ash-forget-plan-risk, .ash-forget-plan-retained/.dissent, .ash-forget-plan-blocked-note
 *   OPERATOR .ash-label, .ash-profile-source-meta, .ash-profile-access, .ash-profile-bindings,
 *            .ash-native-config-row, .ash-profile-state, .ash-profile-status, .ash-profile-notice,
 *            .checks, .ash-forget-plan-step-state
 * Reading 12px has no 12 on the reading ramp and must not tighten → --ds-reading-body3 (13/20).
 * Operator 12 → --ds-operator-label1 (12).
 *
 * Rounding rule, declared before it was applied (same as t-7cb9fe): nearest step; tie-break
 * 4>2>8>6>12>24>16>10>32>20. 1px distance → 2.
 *
 * WHY THESE FIXTURES: `canonical-disabled` is the fullest default screen (lifecycle, readiness,
 * provenance, bindings, native-config, form). `forget-plan` is the only fixture that mounts the
 * 3-column plan the sheet spends a third of its rules on — a pass that only loaded
 * canonical-disabled would never see it.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is
 * the evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/agent-studio-shell-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-agent-studio-shell";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const fixtures = ["canonical-disabled", "forget-plan"];

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
    const waitFor = fixture.startsWith("forget-plan") ? ".ash-forget-plan" : ".ash-fields";
    const surface = await openPreview(page, {
      view: "agent-studio-shell",
      fixture,
      width: w,
      height: 1400,
      waitFor,
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
      return {
        counts: {
          labels: document.querySelectorAll(".ash-label").length,
          hints: document.querySelectorAll(".hint").length,
          sources: document.querySelectorAll(".ash-profile-source").length,
          steps: document.querySelectorAll(".ash-forget-plan-step").length,
          checks: document.querySelectorAll(".checks label, .check").length,
        },
        fields: box(".ash-fields", ["gap", "width"]),
        identity: box(".ash-identity", [...pad, "gap"]),
        label: box(".ash-label", ["font-size", "margin-bottom", "letter-spacing"]),
        hint: box(".hint", ["font-size", "line-height"]),
        access: box(".ash-profile-access", [...pad, "font-size"]),
        state: box(".ash-profile-state", [...pad, "font-size"]),
        status: box(".ash-profile-status", ["font-size"]),
        sourceMeta: box(".ash-profile-source-meta", ["font-size"]),
        sourceGrid: box(".ash-profile-source-grid", ["gap", "grid-template-columns"]),
        bindings: box(".ash-profile-bindings", ["font-size", "gap"]),
        nativeRow: box(".ash-native-config-row", ["font-size", "gap", "grid-template-columns"]),
        readiness: box(".ash-runtime-readiness", [...pad, "font-size", "gap"]),
        risk: box(".ash-native-config-risk", ["font-size", "line-height"]),
        empty: box(".ash-native-config-empty", ["font-size", "line-height"]),
        checks: box(".checks", ["font-size", "gap"]),
        forgetPlan: box(".ash-forget-plan", ["gap"]),
        forgetStep: box(".ash-forget-plan-step", ["gap", "grid-template-columns"]),
        forgetState: box(".ash-forget-plan-step-state", ["font-size"]),
        forgetDetail: box(".ash-forget-plan-step-detail", ["font-size", "line-height"]),
        forgetRisk: box(".ash-forget-plan-risk", ["font-size", "line-height"]),
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
    `${k.padEnd(28)} label ${v.label?.["font-size"]}  hint ${v.hint?.["font-size"]}/${v.hint?.["line-height"]}  access-pt ${v.access?.["padding-top"]}  steps ${v.counts.steps}  overflow ${o.scrollW > o.clientW ? `YES ${o.scrollW}>${o.clientW} ${o.over.join(",")}` : "no"}`,
  );
}
