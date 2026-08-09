/**
 * `t-045d44` (SDD 479) — do the two per-component options actually change the painted card?
 *
 * The unit tests assert what the renderer EMITS: a shortened label with the full value in `title`, and
 * a `--card-focus-lines` custom property. Neither can prove the second one does anything, because the
 * clamp lives in `sidebar.css` and a static render has no layout engine — `line-clamp` either applies
 * or silently does not, and only a browser knows which. That gap is exactly the one phase 2 refused to
 * ship into: a key the card accepts but cannot act on.
 *
 * So this measures geometry. The focus text of the configured row must occupy MORE than one line and
 * at most the three the template allows, while the unconfigured contrast row stays on one.
 *
 * Prereq: `npm run build` and `node scripts/webview-preview/serve.mjs` in another shell.
 * Run: `node scripts/visual-qa/card-template-options.mjs`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();
// a real sidebar width, where wrapping matters. t-b24282 — the width goes to the HARNESS, which is
// what makes it the surface's own viewport rather than a browser window the card never sees.
await page.setViewport({ width: 420, height: 900 });
let surface = await openPreview(page, { view: "sidebar", fixture: "card-template-options", width: 420, height: 900, settleMs: 700 });

const probe = await surface.evaluate(() => {
  const rowFor = (name) =>
    [...document.querySelectorAll(".row")].find((el) => el.querySelector(".name")?.textContent?.startsWith(name));
  const read = (name) => {
    const row = rowFor(name);
    if (!row) return { found: false };
    const model = row.querySelector(".model");
    const focusText = row.querySelector(".row-focus .focus-text");
    const lineHeight = focusText ? parseFloat(getComputedStyle(focusText).lineHeight) : 0;
    return {
      found: true,
      modelText: model?.textContent ?? null,
      modelTitle: model?.getAttribute("title") ?? null,
      // Rounded against the computed line-height: the reliable way to ask "how many lines is this".
      focusLines: focusText && lineHeight ? Math.round(focusText.getBoundingClientRect().height / lineHeight) : 0,
      focusClamp: focusText ? getComputedStyle(focusText).webkitLineClamp : null,
    };
  };
  return { configured: read("truncated-model"), contrast: read("short-model") };
});

/**
 * The unconfigured card, measured in the same browser. Both rows above share one template, so neither
 * shows what a workspace that configured NOTHING gets — and "the default is unchanged" is the claim
 * the whole phase rests on. `sidebar.css` keys the multi-line rule off the custom property's presence,
 * so the property must be absent and the single-line `nowrap` must still be in force.
 */
surface = await openPreview(page, { view: "sidebar", fixture: "card-template-options-default", width: 420, height: 900, settleMs: 500 });
const unconfigured = await surface.evaluate(() => {
  const focusText = document.querySelector(".row-focus .focus-text");
  const holder = document.querySelector(".row-focus");
  return {
    found: !!focusText,
    whiteSpace: focusText ? getComputedStyle(focusText).whiteSpace : null,
    clamp: focusText ? getComputedStyle(focusText).webkitLineClamp : null,
    styleAttr: holder?.getAttribute("style") ?? null,
    modelTitle: document.querySelector(".row .model")?.getAttribute("title") ?? null,
  };
});

const { configured, contrast } = probe;
const checks = [
  ["an unconfigured card has a focus line to measure (precondition)", unconfigured.found === true],
  ["an unconfigured card sets no --card-focus-lines", (unconfigured.styleAttr ?? "").includes("--card-focus-lines") === false],
  ["and keeps the shipped single-line nowrap", unconfigured.whiteSpace === "nowrap" && unconfigured.clamp === "none"],
  ["and truncates no model label", unconfigured.modelTitle === null],
  ["both fixture rows rendered (precondition)", configured.found === true && contrast.found === true],
  ["the long model label is shortened", typeof configured.modelText === "string" && configured.modelText.length <= 12],
  ["its full value stays reachable in the tooltip", configured.modelTitle === "claude-opus-4-5-20251101-preview"],
  ["a label that fits carries no tooltip", contrast.modelTitle === null],
  ["focus.lines actually wraps past one line", configured.focusLines > 1],
  ["and is clamped at the 3 the template allows", configured.focusLines <= 3 && configured.focusClamp === "3"],
  ["the row with short focus text still occupies one line", contrast.focusLines === 1],
];

let failures = 0;
for (const [name, ok] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
console.log(`probe=${JSON.stringify(probe)}`);
console.log(`unconfigured=${JSON.stringify(unconfigured)}`);

await browser.close();
console.log(failures === 0
  ? "\nCARD TEMPLATE OPTIONS QA PASS — both options change the painted card"
  : `\nCARD TEMPLATE OPTIONS QA FAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
