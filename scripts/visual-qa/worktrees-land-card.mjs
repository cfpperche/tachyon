/**
 * t-ea5425 — the two-width visual pass for the `LAND THIS DELIVERY` block on the Worktrees tab.
 *
 * ANCHOR, written from the task's problem statement BEFORE the surface was touched (an anchor written
 * afterwards only proves the screenshot matches itself):
 *
 *   The land block sits inside a wide card and must USE that card. At 880: every precondition sentence
 *   and its `Fix:` line run out to the block's own inner edge instead of stopping in a narrow river with
 *   empty card to their right; the unproved (red) precondition is the first thing the eye lands on; and
 *   `Fix: run the declared verify gate IN this worktree, and commit nothing after it — the tree you land
 *   must be the tree you verified` — the ONE actionable line on the surface — is not chopped into three
 *   ragged fragments. At 360 the block stays readable and nothing overflows the page horizontally.
 *
 *   What must NOT change: the land door is not redesigned. Same sections in the same order (title +
 *   count, intro, checks, command-or-refusal, the compare sentence and the two read-only doors), same
 *   verdict colours, and the neighbouring rows/cards of the tab untouched.
 *
 * The measurement that stands for "uses the card": `fill` = the widest rendered text line box in the
 * checks list ÷ the block's own content width. A river inside a wide card scores low because the lines
 * stop early; text that uses its column scores high. It is measured on the RENDERED line boxes (Range
 * client rects), not on the element box, because a block element is always as wide as its container
 * even when its text stops a third of the way in — which is exactly the defect being fixed.
 *
 * Prereq: `npm run build` and `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT respected) in
 * another shell.
 * Run: `node scripts/visual-qa/worktrees-land-card.mjs [outDir] [label]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { openPreview } from "./preview-surface.mjs";

const outDir = process.argv[2] ?? ".vqa/t-ea5425";
const label = process.argv[3] ?? "shot";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = [];
for (const w of widths) {
  const page = await browser.newPage();
  // Tall on purpose: the card is what is being photographed, and an element taller than the frame comes
  // back half black. 1600 fits both land blocks at either width.
  await page.setViewport({ width: w, height: 1600 });
  const surface = await openPreview(page, {
    view: "worktrees",
    fixture: "default",
    width: w,
    height: 1600,
    waitFor: '[data-testid="worktree-land"]',
    settleMs: 500,
  });

  const m = await surface.evaluate(() => {
    const de = document.documentElement;
    /**
     * Rendered line boxes of an element's text — a block's own box is not evidence about its text.
     *
     * Merged by line TOP, because `Range.getClientRects()` returns one rect per inline fragment: a
     * sentence carrying a `<b>` label reports two rects on its first line and would score as wrapping
     * more than the same sentence without one. Counting distinct tops measures the line count a reader
     * sees. (For a fix line with no inline child the two counts coincide, which is why the pre-change
     * measurement remains comparable.)
     */
    const lineBoxes = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const byTop = new Map();
      for (const b of [...r.getClientRects()].filter((b) => b.width > 1 && b.height > 1)) {
        const key = Math.round(b.top);
        const prev = byTop.get(key);
        byTop.set(key, prev ? { top: key, left: Math.min(prev.left, b.left), right: Math.max(prev.right, b.right) } : { top: key, left: b.left, right: b.right });
      }
      return [...byTop.values()].map((b) => ({ top: b.top, width: b.right - b.left, height: 1 }));
    };
    const contentWidth = (el) => {
      const cs = getComputedStyle(el);
      return el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    };
    const scrolls = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      }
      return false;
    };
    const blocks = [...document.querySelectorAll('[data-testid="worktree-land"]')];
    const measured = blocks.map((block) => {
      const card = block.closest(".ds-list-row");
      const inner = contentWidth(block);
      const checkLines = [...block.querySelectorAll(".ck-land-checks .ck-land-check-body")].flatMap(lineBoxes);
      const widest = checkLines.reduce((a, b) => Math.max(a, b.width), 0);
      const fixes = [...block.querySelectorAll(".ck-land-fix")].map((el) => ({
        text: el.textContent.trim().slice(0, 48),
        lines: lineBoxes(el).length,
        widest: Math.round(lineBoxes(el).reduce((a, b) => Math.max(a, b.width), 0)),
      }));
      const bad = [...block.querySelectorAll(".ck-land-bad")];
      return {
        cardInner: Math.round(card ? contentWidth(card) : 0),
        blockInner: Math.round(inner),
        // the block's share of the card, and the text's share of the block
        blockOfCard: card ? +(contentWidth(block) / contentWidth(card)).toFixed(2) : null,
        fill: inner > 0 ? +(widest / inner).toFixed(2) : null,
        widestLine: Math.round(widest),
        checkCount: block.querySelectorAll(".ck-land-checks li").length,
        badCount: bad.length,
        // the sections that must all still be present — "not a redesign"
        sections: {
          title: !!block.querySelector(".ck-land-title"),
          intro: !!block.querySelector(".ck-land-intro"),
          checks: !!block.querySelector(".ck-land-checks"),
          commandOrRefusal: !!(block.querySelector(".ck-land-command") || block.querySelector(".ck-land-blocked")),
          compare: !!block.querySelector(".ck-land-compare"),
          actions: [...block.querySelectorAll(".ck-land-actions button")].map((b) => b.textContent.trim()),
        },
        fixes,
      };
    });
    const over = [...document.querySelectorAll('[data-testid="worktree-land"] *')]
      .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}`);
    return { blocks: measured, scrollW: de.scrollWidth, clientW: de.clientWidth, over: over.slice(0, 4) };
  });

  await page.screenshot({ path: `${outDir}/page-${label}-${w}.png`, fullPage: true });
  // The card itself, cropped — the tab is taller than the frame at 360, so a page shot alone would
  // photograph everything except the block this task is about.
  const cards = await surface.$$('[data-testid="worktree-land"]');
  for (const [i, card] of cards.entries()) {
    const state = (m.blocks[i]?.badCount ?? 0) > 0 ? "blocked" : "ready";
    await card.screenshot({ path: `${outDir}/land-${label}-${w}-${state}.png` });
  }
  /**
   * t-ea5425 — the picker, photographed where it actually opens.
   *
   * The candidate list is a host PUSH, so the harness plays the host: the same message the panel posts
   * (`worktreeReviewFiles`) is delivered to the surface's own window, which is the door `main.tsx`
   * listens on. Nothing is stubbed — the real bundle receives the real message.
   */
  await surface.evaluate((review) => window.postMessage({ type: "worktreeReviewFiles", review }, "*"), {
    id: "mw-change-unlanded",
    label: "tachyon/change/t-7cb971",
    base: "main",
    current: "c47b8e10d9a3",
    files: [
      { path: "packages/webview-ui/src/webview/worktrees/App.tsx", status: "M" },
      { path: "packages/webview-ui/src/webview/shared/ui/patterns.tsx", status: "M" },
      { path: "packages/webview-ui/src/webview/shared/design-system.css", status: "M" },
      { path: "apps/vscode-extension/src/presentation/items.ts", status: "M" },
      { path: "scripts/visual-qa/worktrees-land-card.mjs", status: "A" },
      { path: "packages/webview-ui/src/webview/worktrees/land.css", status: "R", from: "packages/webview-ui/src/webview/worktrees/old-land.css" },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const picker = await surface.$('[data-testid="worktree-review-picker"]');
  if (picker) {
    await page.screenshot({ path: `${outDir}/picker-${label}-${w}.png` });
    const geom = await surface.evaluate(() => {
      const panel = document.querySelector('[data-testid="worktree-review-picker-panel"]');
      const items = [...document.querySelectorAll('[data-testid="worktree-review-picker-item"]')];
      const de = document.documentElement;
      const box = panel?.getBoundingClientRect();
      return {
        items: items.length,
        first: items[0]?.textContent?.trim() ?? null,
        panelWidth: box ? Math.round(box.width) : null,
        insideViewport: box ? box.left >= -0.5 && box.right <= de.clientWidth + 0.5 : false,
      };
    });
    console.log(`  picker: items=${geom.items} panel=${geom.panelWidth}px inside=${geom.insideViewport} first=${JSON.stringify(geom.first)}`);
    report.push({ width: w, picker: geom });
  } else {
    console.log("  picker: NOT RENDERED — the host push did not open it");
  }
  report.push({ width: w, ...m });

  const noOverflow = m.scrollW <= m.clientW && m.over.length === 0;
  console.log(`w=${w} blocks=${m.blocks.length} overflow=${noOverflow ? "none" : JSON.stringify(m.over)} scrollW=${m.scrollW}/${m.clientW}`);
  for (const b of m.blocks) {
    console.log(
      `  card=${b.cardInner} block=${b.blockInner} (${b.blockOfCard} of card) fill=${b.fill} widest=${b.widestLine} ` +
        `checks=${b.checkCount} red=${b.badCount} actions=${JSON.stringify(b.sections.actions)}`,
    );
    for (const f of b.fixes) console.log(`    fix lines=${f.lines} widest=${f.widest} "${f.text}…"`);
  }
  await page.close();
}

await browser.close();
writeFileSync(`${outDir}/land-${label}.json`, JSON.stringify(report, null, 2));
console.log(`\nscreenshots + measurements in ${outDir} (label ${label})`);
