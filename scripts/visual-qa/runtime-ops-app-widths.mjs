/**
 * SDD 485 D3 — the two-width visual pass for Runtime Ops as a standalone app.
 *
 * ANCHOR, written from the task's problem statement BEFORE the surface was measured (an anchor written
 * afterwards only proves the screenshot matches itself):
 *
 *   Runtime Ops must arrive as a first-class editor tab showing the SAME runtime inventory it showed
 *   inside Control — nothing gained and nothing lost by the move. At 880: the page chrome above a summary
 *   strip of five metrics with the snapshot timestamp pushed to its right edge, the provider-capacity
 *   block below it reading provider identity · quota windows · control on one row per provider, and the
 *   runtime table below that with its five column headers and one group per runtime, all of it inside the
 *   surface's OWN single page pad. That pad is the sharpest claim here and the inverse of D2's: it always
 *   lived in `runtime-ops.css` rather than in `cockpit.css`, so it must measure the SAME after the two
 *   embed-context rules (cockpit.css's `.ck-embed-host > .runtime-ops`, this sheet's `!important`
 *   re-assert) were deleted — a pad that changed would mean one of those two was load-bearing after all.
 *   At 360: usable rather than clipping, with `runtime-ops.css`'s own `@container (max-width: 720px)` and
 *   `@media (max-width: 760px)` blocks firing, and nothing overflowing the page horizontally. And at BOTH
 *   widths the two CROSS-WORKSPACE facts must be legible — a runtime row naming every workspace it spans,
 *   and the provider block stating that its quota is account-wide and attributed to no workspace — because
 *   those are the visible evidence for the `window` cardinality this task took against its own brief, and
 *   a decision whose evidence is only in a test is a decision the next reader cannot check.
 *
 * Two harness rules this repo paid for, both applied here:
 *  - viewport AND `?width=` together (t-b24282): `?width=` alone narrows a div while `@media` still reads
 *    the 1280px browser viewport, so a breakpoint measured that way silently tests nothing. It matters on
 *    THIS surface for real — `runtime-ops.css` carries a `@media (max-width: 760px)` block AND an
 *    `@container (max-width: 720px)` one, and only the first needs the viewport (the container query reads
 *    `.runtime-ops`'s own inline size, which `?width=` does move). Setting both is what measures both;
 *  - measure with volume, on fixtures that already exist rather than a fiction invented to photograph.
 *    `provider-healthy` is the fullest screen this surface has (summary + two providers × two quota
 *    windows + three runtimes across two workspaces); `long-label` is the width-stress fixture the retired
 *    browser suite drove at 340px; `duplicate-workspace` is the one whose whole point is two workspaces
 *    with same-named agents, which is the cardinality's own case.
 *
 * Prereq: `node esbuild.mjs` and `npm run preview:webview` in another shell.
 * Run: `node scripts/visual-qa/runtime-ops-app-widths.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/485-d3";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
/**
 * Each fixture with what it exists to show, and the counts read from `fixtures/runtime-ops.ts` — not
 * guessed. Two corrections the first runs of this driver forced, both recorded because they are the kind
 * of thing that otherwise gets quietly rewritten until it passes:
 *
 *  1. the capacity block is ALWAYS present, two rows, even where no observation is configured — an
 *     unobserved provider renders as "not observed" rather than vanishing. That is the honest answer and
 *     the one Control has always given: `runtime-ops/App.tsx`, these fixtures and `src/runtimeOps/` are
 *     byte-identical across this migration, so there was nowhere for a behaviour change to hide;
 *  2. `mixed` is literally `const mixed = providerHealthy` — the same object. Measuring both would have
 *     photographed one screen twice while reporting two passes, so `throttled` and `provider-exhausted`
 *     take its slot and cover renderings nothing else here does (the rate-limit row, and the `exhausted`
 *     meter that turns `--ds-err`).
 */
//
// The quota counts follow one structural rule in `fixtures/runtime-ops.ts`, which is why they are stated
// rather than derived here: a fixture built through `withProviderState(...)` carries that state's quota
// windows; one built bare through `buildRuntimeOpsSnapshot({...})` carries none, and its two provider rows
// both read "not observed".
const cases = [
  { fixture: "provider-healthy", quotas: 4, note: "the fullest screen: summary + two providers × two quota windows + three runtimes" },
  { fixture: "throttled", quotas: 0, note: "an agent throttled with a rate-limit reset — the attention state this surface exists for" },
  { fixture: "provider-exhausted", quotas: 2, note: "100% / 99.8% — the exhausted meter and its err-toned label" },
  { fixture: "long-label", quotas: 0, note: "the width stress the retired browser suite drove at 340px" },
  { fixture: "duplicate-workspace", quotas: 0, note: "two workspaces, same agent name — the cardinality's own case" },
];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

let bad = 0;
let ran = 0;
for (const c of cases) {
  for (const w of widths) {
    ran += 1;
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 900 });
    await page.goto(
      `http://localhost:5174/scripts/webview-preview/index.html?view=runtime-ops&fixture=${c.fixture}&width=${w}&height=900`,
      { waitUntil: "networkidle0", timeout: 45000 },
    );
    await new Promise((r) => setTimeout(r, 700));

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const root = document.querySelector(".runtime-ops");
      const scrolls = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
        }
        return false;
      };
      // `de.clientWidth` is the page box; anything whose right edge escapes it, and which is not clipped
      // by a scrolling ancestor, is real horizontal overflow.
      const over = [...document.querySelectorAll(".runtime-ops *")]
        .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 34)}`);
      const rows = (sel) => new Set([...document.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().top))).size;
      const top = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      };
      const updated = document.querySelector(".runtime-ops-updated");
      const summary = document.querySelector(".runtime-ops-summary");
      // the timestamp is `margin-left: auto` — at 880 it must sit at the strip's right edge.
      const updatedFlushRight = updated && summary
        ? Math.round(summary.getBoundingClientRect().right - updated.getBoundingClientRect().right)
        : null;
      // the two cross-workspace facts the cardinality rests on, read as TEXT rather than by eye.
      const workspaceCells = [...document.querySelectorAll('.runtime-ops-cell[data-label="Agents"] span')]
        .map((e) => e.textContent.trim()).filter(Boolean);
      const capacityCopy = document.querySelector(".runtime-ops-capacity-header p")?.textContent?.trim() ?? null;
      return {
        rendered: !!root,
        summaryItems: document.querySelectorAll(".runtime-ops-summary-item").length,
        summaryRows: rows(".runtime-ops-summary-item"),
        providerRows: document.querySelectorAll(".runtime-ops-provider-row").length,
        quotaWindows: document.querySelectorAll(".runtime-ops-quota-window").length,
        runtimeGroups: document.querySelectorAll(".runtime-ops-runtime-group").length,
        headerVisible: getComputedStyle(document.querySelector(".runtime-ops-header") ?? document.body).display,
        // the surface's OWN page pad — unchanged by the migration is the claim.
        padLeft: root ? getComputedStyle(root).paddingLeft : null,
        padTop: root ? getComputedStyle(root).paddingTop : null,
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        over: over.slice(0, 4),
        chromeTop: top(".ds-page-chrome"),
        summaryTop: top(".runtime-ops-summary"),
        capacityTop: top(".runtime-ops-capacity"),
        tableTop: top(".runtime-ops-table"),
        updatedFlushRight,
        workspaceCells,
        capacityCopy,
      };
    });

    await page.screenshot({ path: `${outDir}/runtime-ops-${c.fixture}-${w}.png`, fullPage: true });

    const noOverflow = m.scrollW <= m.clientW && m.over.length === 0;
    const padded = m.padLeft && m.padLeft !== "0px" && m.padTop && m.padTop !== "0px";
    // the capacity block is always present (an unobserved provider still gets a row); the quota windows
    // are what the fixtures differ on.
    const providersOk = m.providerRows === 2 && m.quotaWindows === c.quotas;
    // the account-wide sentence is the provider block's own copy, and it is one of the two cross-workspace
    // facts the `window` cardinality rests on — so it is asserted at BOTH widths, on every fixture.
    const capacityOk = /account-wide/i.test(m.capacityCopy ?? "");
    // the other one: at least one runtime row must NAME the workspaces it spans.
    const workspacesOk = m.workspaceCells.length > 0;
    const ok = m.rendered && m.summaryItems === 5 && m.runtimeGroups > 0 && noOverflow && padded
      && providersOk && capacityOk && workspacesOk;
    if (!ok) bad += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${c.fixture}@${w} pad=${m.padTop}/${m.padLeft} scrollW=${m.scrollW} clientW=${m.clientW} ` +
        `summary=${m.summaryItems}/${m.summaryRows}rows providers=${m.providerRows} quotas=${m.quotaWindows} ` +
        `runtimes=${m.runtimeGroups} header=${m.headerVisible} ` +
        `chrome/summary/capacity/table=${m.chromeTop}/${m.summaryTop}/${m.capacityTop}/${m.tableTop} ` +
        `updatedGap=${m.updatedFlushRight} ws=${JSON.stringify(m.workspaceCells.slice(0, 3))}` +
        (m.over.length ? ` over=${JSON.stringify(m.over)}` : ""),
    );
    await page.close();
  }
}

await browser.close();
console.log(bad === 0 ? `\nVISUAL QA PASS — ${ran}/${ran}, screenshots in ${outDir}` : `\nVISUAL QA FAIL — ${bad}/${ran}`);
process.exit(bad ? 1 : 0);
