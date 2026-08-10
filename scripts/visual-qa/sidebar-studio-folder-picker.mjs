/**
 * t-be359b — the two-width visual pass for the "new …" studio FOLDER choice in the sidebar.
 *
 * ANCHOR, written from the task's problem statement BEFORE the surface was touched (an anchor
 * written afterwards only proves the screenshot matches itself):
 *
 *   The owner's rule is "não queremos isso no projeto, nós criamos nossos próprios pickers". So when
 *   a human clicks "+ New agent" in the sidebar with MORE THAN ONE Tachyon folder open, the question
 *   "which folder?" must be asked in OUR chrome: the product QuickPicker — design-system tokens, a
 *   filter box, one row per configured folder naming it, and the ↑↓ / ↵ / esc legend — drawn over
 *   the sidebar the human clicked in. It must NOT be a VS Code quick pick floating at the top of the
 *   window, detached from the surface that raised it.
 *
 *   What must NOT change: the sidebar behind it. Same tabs, same rows, same chrome; the picker is an
 *   overlay on the surface, not a redesign of it. And with a SINGLE folder configured there is no
 *   question to ask, so no picker may appear at all.
 *
 *   At 360 the panel stays inside its surface and nothing overflows horizontally.
 *
 * The measurement that stands for "asked in our chrome": the picker's own testid is present, it
 * carries one row per configured folder, and `overflow` reports the surface's horizontal scroll.
 *
 * Prereq: `node esbuild.mjs` and `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT respected).
 * Run: `node scripts/visual-qa/sidebar-studio-folder-picker.mjs [outDir] [label]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { openPreview } from "./preview-surface.mjs";

const outDir = process.argv[2] ?? ".vqa/t-be359b";
const label = process.argv[3] ?? "shot";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = [];

/** Click the Agents tab's "New agent" (+) action — the door production uses. */
async function openThePicker(surface) {
  const clicked = await surface.evaluate(() => {
    const add = document.querySelector('[title="New agent"]');
    if (!add) return false;
    (add).click();
    return true;
  });
  if (!clicked) throw new Error('no "New agent" (+) action on the Agents tab — the door moved');
  await surface.waitForSelector('[data-testid="studio-folder-picker"]', { visible: true, timeout: 5000 });
}

for (const w of widths) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 900 });
  const surface = await openPreview(page, {
    view: "sidebar",
    fixture: "multi-project",
    width: w,
    height: 860,
    waitFor: "#root",
    settleMs: 150,
  });

  await openThePicker(surface);

  const measured = await surface.evaluate(() => {
    const panel = document.querySelector('[data-testid="studio-folder-picker-panel"]');
    const rows = [...document.querySelectorAll('[data-testid="studio-folder-picker-item"]')];
    const filter = document.querySelector('[data-testid="studio-folder-picker-filter"]');
    const foot = document.querySelector(".ds-qp-foot");
    const panelBox = panel?.getBoundingClientRect();
    return {
      drawnInOurChrome: !!panel,
      // The rows are the whole point: one per configured folder, named, with its Bridge port.
      rows: rows.map((r) => ({
        label: r.querySelector(".ds-qp-label")?.textContent?.trim() ?? "",
        description: r.querySelector(".ds-qp-desc")?.textContent?.trim() ?? "",
      })),
      hasFilterBox: !!filter,
      hasKeyLegend: !!foot && /esc/i.test(foot.textContent ?? ""),
      panelWidth: panelBox ? Math.round(panelBox.width) : 0,
      surfaceWidth: document.documentElement.clientWidth,
      // A panel wider than its surface, or a page that scrolls sideways, is the defect 360 catches.
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sidebarStillBehind: !!document.querySelector("#root .panel"),
    };
  });

  const file = `${outDir}/${label}-${w}.png`;
  await page.screenshot({ path: file });
  report.push({ width: w, file, ...measured });
  await page.close();
}

// The negative half of the anchor: one configured folder must ask NOTHING.
{
  const page = await browser.newPage();
  await page.setViewport({ width: 880, height: 900 });
  const surface = await openPreview(page, {
    view: "sidebar",
    fixture: "default",
    width: 880,
    height: 860,
    waitFor: "#root",
    settleMs: 150,
  });
  const single = await surface.evaluate(() => {
    const add = document.querySelector('[title="New agent"]');
    if (add) (add).click();
    return {
      clickedAdd: !!add,
      pickerAppeared: !!document.querySelector('[data-testid="studio-folder-picker"]'),
    };
  });
  const file = `${outDir}/${label}-single-root-880.png`;
  await page.screenshot({ path: file });
  report.push({ width: 880, file, case: "single-root", ...single });
  await page.close();
}

await browser.close();

writeFileSync(`${outDir}/${label}-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
