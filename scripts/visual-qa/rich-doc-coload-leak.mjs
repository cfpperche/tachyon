/**
 * `t-61189b` — does `rich-doc.css` still reach surfaces it does not own?
 *
 * The unit guard asserts the SHEET is namespaced. This asserts the consequence, in a browser, under
 * the condition that produced the bug: the Control lazily co-loads this sheet on a Task/Pin Studio
 * visit and never unloads it, so every other route inherits its rules for the rest of the session.
 * The preview harness reproduces that faithfully on its own — the cockpit route already lists
 * `/dist/webview/rich-doc.css` (routes.ts) — so the Task Detail page under test is served with the
 * sheet present, exactly as the real panel serves it after a Studio visit.
 *
 * (An earlier version of this script ALSO injected the sheet and asserted "injecting changes
 * nothing". That check was vacuous: the sheet was already there, so it compared a state to itself
 * and passed even while the two real assertions below were failing.)
 *
 * What is measured is the symptom from the report: `.err { position: fixed }` matched
 * `.ds-badge.err` and tore the missing-dependency badge out of the Dependencies list to pin it at
 * the window bottom. Verified to FAIL against the pre-fix sheet — `position: fixed`,
 * `insideItsList: false` — so a pass means something.
 *
 * Prereq: `npm run build` and `npm run preview:webview` in another shell.
 * Run: `node scripts/visual-qa/rich-doc-coload-leak.mjs`
 */
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 900 });
await page.goto("http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=task-detail-heavy", {
  waitUntil: "networkidle0",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 700));

const probe = await page.evaluate(() => {
  // The sheet must actually be present, or every assertion below passes for the wrong reason.
  const coLoaded = [...document.styleSheets].some((s) => (s.href ?? "").includes("rich-doc.css"));
  const badge = document.querySelector(".td-deps-list .ds-badge.err");
  const list = document.querySelector(".td-deps-list");
  const style = badge ? getComputedStyle(badge) : null;
  const inside = badge && list
    ? (() => {
        const b = badge.getBoundingClientRect(), l = list.getBoundingClientRect();
        return b.top >= l.top - 1 && b.bottom <= l.bottom + 1;
      })()
    : null;
  // `.ds-degrade` was the wider leak: rich-doc.css redefined a design-system class, so every
  // loading state in the Control gained a 20vh top margin once a Studio had been visited.
  const probeEl = document.createElement("div");
  probeEl.className = "ds-degrade";
  document.body.appendChild(probeEl);
  const degradeMarginTop = getComputedStyle(probeEl).marginTop;
  probeEl.remove();
  return {
    coLoaded,
    found: !!badge,
    position: style?.position ?? null,
    insideItsList: inside,
    degradeMarginTop,
  };
});

const checks = [
  ["rich-doc.css IS co-loaded (precondition — otherwise this proves nothing)", probe.coLoaded === true],
  ["the missing-dependency badge exists to be measured", probe.found === true],
  ["badge stays in normal flow", probe.position === "static" || probe.position === "relative"],
  ["badge stays inside its Dependencies list", probe.insideItsList === true],
  ["a foreign .ds-degrade keeps the design system's own margin", probe.degradeMarginTop === "0px"],
];

let failures = 0;
for (const [name, ok] of checks) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
console.log(`probe=${JSON.stringify(probe)}`);

await browser.close();
console.log(failures === 0
  ? "\nRICH-DOC CO-LOAD QA PASS — the sheet no longer reaches Task Detail"
  : `\nRICH-DOC CO-LOAD QA FAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
