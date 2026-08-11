/**
 * t-7d6013 — the two-width visual pass for the durable config-discard banner.
 *
 * ANCHOR, written from the task's problem statement BEFORE the surface was rendered (an anchor
 * written afterwards only proves the screenshot matches itself):
 *
 *   When `tachyon.yml` loads with lines the parser DROPPED, the sidebar must carry a record that
 *   outlives the toast. At the top of the Agents tab: warn-toned and unmistakably NOT the red
 *   "invalid tachyon.yml" banner, since the file loaded and the fleet is live; it names the file and
 *   how many lines were ignored, shows the first dropped line verbatim with the rest reachable, says
 *   that each ignored line runs the product default instead, and offers exactly two actions — open
 *   the file, or DISMISS, because a durable notice a human cannot take off the screen is worse than
 *   the toast it replaces. The fleet underneath must look untouched: the same rows, no "config
 *   invalid" marks, no degraded roster. At 880 the banner reads as one block with its actions on one
 *   row; at 360 the long parser line wraps INSIDE the banner rather than overflowing the sidebar, and
 *   the actions stay within its border. With no discards pending, none of it appears at either width.
 *
 * The control (`default`, the same SAMPLE fleet with no discards) is measured at both widths too: the
 * claim "the fleet underneath is untouched" cannot be judged from the banner's own capture.
 *
 * Prereq: `node esbuild.mjs` and `node scripts/webview-preview/serve.mjs` in another shell.
 * Run: `node scripts/visual-qa/config-discard-banner.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { openPreview } from "./preview-surface.mjs";

const outDir = process.argv[2] ?? ".vqa/t-7d6013";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const cases = [
  { fixture: "config-discards", discards: true, note: "five dropped declarations, banner pending" },
  { fixture: "default", discards: false, note: "control — nothing discarded" },
];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

let bad = 0;
let ran = 0;
const say = (ok, label) => {
  ran += 1;
  if (!ok) bad += 1;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}\n`);
};

const page = await browser.newPage();
for (const width of widths) {
  for (const c of cases) {
    await page.setViewport({ width, height: 900 });
    const surface = await openPreview(page, { view: "sidebar", fixture: c.fixture, width, height: 900, settleMs: 350 });
    const probe = await surface.evaluate(() => {
      const banner = document.querySelector(".discard-banner");
      const error = document.querySelector(".config-error-banner:not(.discard-banner):not(.card-template-banner)");
      if (!banner) {
        return {
          present: false,
          errorBanner: !!error,
          rows: document.querySelectorAll(".row").length,
          invalidRows: document.querySelectorAll(".row .config-invalid, .row.config-invalid").length,
          docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      }
      const box = banner.getBoundingClientRect();
      const actions = [...banner.querySelectorAll(".config-error-actions .ds-btn")];
      const summary = banner.querySelector(".config-error-summary");
      return {
        present: true,
        errorBanner: !!error,
        role: banner.getAttribute("role"),
        title: banner.querySelector(".config-error-title strong")?.textContent ?? null,
        summaryText: summary?.textContent ?? null,
        summaryTitleLines: (summary?.getAttribute("title") ?? "").split("\n").length,
        note: banner.querySelector(".config-discard-note")?.textContent ?? null,
        actionLabels: actions.map((el) => el.textContent?.trim() ?? ""),
        // one row at 880, and at 360 they may wrap — either way they must stay inside the border.
        actionsInside: actions.every((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
        }),
        actionsOneRow: new Set(actions.map((el) => Math.round(el.getBoundingClientRect().top))).size === 1,
        summaryInside: summary
          ? summary.getBoundingClientRect().right <= box.right + 0.5
          : false,
        summaryLines: summary
          ? Math.round(summary.getBoundingClientRect().height / parseFloat(getComputedStyle(summary).lineHeight))
          : 0,
        rows: document.querySelectorAll(".row").length,
        invalidRows: document.querySelectorAll(".row .config-invalid, .row.config-invalid").length,
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    const shot = `${outDir}/sidebar-${c.fixture}-${width}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    process.stdout.write(`\n— ${c.fixture} @ ${width} (${c.note}) → ${shot}\n`);

    say(probe.present === c.discards, `banner ${c.discards ? "present" : "absent"}`);
    say(probe.errorBanner === false, "never the red invalid-config banner");
    say(probe.rows > 0, "the fleet still renders rows underneath");
    say(probe.invalidRows === 0, "no row is marked config-invalid");
    say(probe.docOverflow === false, "the sidebar does not scroll horizontally");
    if (!c.discards) continue;

    say(probe.role === "status", "role=status (a report, not an alarm)");
    say(/^5 lines ignored in tachyon\.yml$/.test(probe.title ?? ""), `title names file + count (${probe.title})`);
    say((probe.summaryText ?? "").startsWith("settings.agentPermissionProjection.reviewer: unknown key 'sandbox_mode'"),
      "the first dropped line is shown verbatim");
    say((probe.summaryText ?? "").includes("(+4 more)"), "the rest are counted");
    say(probe.summaryTitleLines === 5, "and all five reachable in the tooltip");
    say((probe.note ?? "").includes("runs the product default"), "the consequence is stated");
    say(probe.actionLabels.length === 2 && probe.actionLabels[1] === "Dismiss",
      `exactly two actions, the second dismisses (${probe.actionLabels.join(" | ")})`);
    say(probe.actionsInside, "actions stay inside the banner border");
    say(probe.summaryInside, "the long parser line stays inside the banner");
    if (width === 880) say(probe.actionsOneRow, "at 880 both actions sit on one row");
    if (width === 360) say(probe.summaryLines > 1, `at 360 the long line WRAPS rather than clipping (${probe.summaryLines} lines)`);
  }
}

await browser.close();
process.stdout.write(`\n${ran - bad}/${ran} checks passed\n`);
process.exit(bad === 0 ? 0 : 1);
