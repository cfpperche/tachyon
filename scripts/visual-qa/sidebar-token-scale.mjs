/**
 * SDD 505 slice 8 (t-9c7ce8) — the two-width visual pass for `sidebar` moving onto the slice-4 tokens.
 *
 * ANCHOR, written from the task's problem statement BEFORE the sheet was touched (an anchor written
 * afterwards only proves the screenshot matches itself). Journalled on t-9c7ce8 as j-fc837b21ad7a,
 * before any CSS edit:
 *
 *   The sidebar keeps the hierarchy and the density it has today: project chrome + search + icon
 *   tabs + section header, then the dense agent list (status groups, name + badges + the board-card
 *   line that distinguishes an agent with a card from one without), pins, attentions, the Control
 *   tile grid, and the six boot screens (unknown / configured-and-starting / delayed / failed /
 *   confirmed-unconfigured / ready). The ONLY acceptable difference is that every rhythm
 *   padding/margin/gap becomes a step of the host ruler (2/4/6/8/10/12/16/20/24/32) and every
 *   label a step of the ramp chosen by role. Off-scale distances go to the nearest step; on a tie
 *   the host frequency wins (benchmark.md §2.4: 4>2>8>6>12>24>16>10>32>20), so 3→4, 5→4, 7→8,
 *   9→8, 13→12, 14→12, 30→32, 1px distance→2. Nothing disappears, nothing starts wrapping that
 *   did not wrap, the six boot states stay present and readable, the with-card / no-card line
 *   stays distinct. At 360: project name shrinks, handoff pill stays in the row, names/badges
 *   ellipsis, no horizontal overflow. At 880: the same chrome, the select stays a control (not a
 *   full-row field).
 *
 *   Declared UP FRONT because they exceed ±2px: .init padding-top 40→32 (the boot/welcome plate;
 *   32 is the top of the scale). NOT snapped, each with a reason: 28px name-column indent on
 *   .row-meta/.row-focus/.row-detail (gutter 13 + gap 6 + sdot 7); 13px child meta/focus pad
 *   (sdot 7 + gap 6); 72px .row-focus padding-right (action overlay gutter, pair of
 *   --action-gutter 80px). Width/height, radius, position, z-index, letter-spacing, 1px stroke,
 *   icon sizes (14/16/17/26) stay.
 *
 * Density, chosen by role (not by file). The sidebar is almost all operator — a dense list, a
 * lot of information in little height — but running prose on the boot/welcome plate is reading.
 *
 *   READING  .init p, .init .dim
 *   OPERATOR chrome, tabs, section titles, group headers, agent names/models/markers, badges,
 *            focus line, metrics, pins, cmdk, menus, attention cards, control tiles, banners,
 *            empty list, boot-row
 *
 * Rounding rule, declared before it was applied (same as t-7cb9fe): every rhythm padding/margin/gap
 * literal goes to the NEAREST step of the ten; on a tie the step the HOST itself uses more in its
 * own already-migrated CSS wins (benchmark.md §2.4).
 *
 * WHY THESE FIXTURES: the five `boot-*` screens plus `default` are the six boot states the owner
 * just added (t-6e7d8a, landed) — `default` is `ready`. `board-assignment-state` is the with-card /
 * no-card distinction (t-9eacf9, landed). Photographing anything else would be a different claim.
 *
 * The numbers are read as computed style rather than by eye: a before/after diff of this JSON is
 * the evidence that the deltas are the scale's and nobody else's.
 *
 * Prereq: `node esbuild.mjs`, then `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT honoured).
 * Run: `node scripts/visual-qa/sidebar-token-scale.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { openPreview } from "./preview-surface.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? ".vqa/505-slice8-sidebar";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];
const fixtures = [
  { fixture: "boot-unknown", waitFor: "[data-testid='sidebar-boot-unknown']" },
  { fixture: "boot-starting", waitFor: "[data-testid='sidebar-boot-configured-and-starting']" },
  { fixture: "boot-delayed", waitFor: "[data-testid='sidebar-boot-delayed']" },
  { fixture: "boot-failed", waitFor: "[data-testid='sidebar-boot-failed']" },
  { fixture: "boot-unconfigured", waitFor: "[data-testid='sidebar-boot-unconfigured']" },
  { fixture: "default", waitFor: ".row" },
  { fixture: "board-assignment-state", waitFor: "[data-testid='agent-board-line']" },
];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const report = {};
for (const { fixture, waitFor } of fixtures) {
  for (const w of widths) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: 1200 });
    const surface = await openPreview(page, {
      view: "sidebar",
      fixture,
      width: w,
      height: 1200,
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
      const textOf = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
      return {
        boot: {
          unknown: !!document.querySelector("[data-testid='sidebar-boot-unknown']"),
          starting: !!document.querySelector("[data-testid='sidebar-boot-configured-and-starting']"),
          delayed: !!document.querySelector("[data-testid='sidebar-boot-delayed']"),
          failed: !!document.querySelector("[data-testid='sidebar-boot-failed']"),
          unconfigured: !!document.querySelector("[data-testid='sidebar-boot-unconfigured']"),
          row: !!document.querySelector("[data-testid='sidebar-boot-row']"),
          initText: textOf(".init p"),
          initDim: textOf(".init .dim"),
        },
        cards: {
          withCard: document.querySelectorAll("[data-testid='agent-board-line']").length,
          noCard: document.querySelectorAll("[data-testid='agent-board-none']").length,
          taskSrc: textOf(".focus-src.src-task"),
          noneSrc: textOf(".focus-src.src-none"),
        },
        counts: {
          rows: document.querySelectorAll(".row").length,
          tabs: document.querySelectorAll(".tab").length,
          badges: document.querySelectorAll(".ds-badge").length,
          inits: document.querySelectorAll(".init").length,
        },
        chrome: box(".ws-chrome", ["gap", "margin-bottom", ...pad]),
        wsSelect: box(".ws-chrome .ws-select", ["font-size", "max-width", "height"]),
        kbar: box(".kbar", [...pad, "gap", "margin-top", "margin-bottom"]),
        kbarGrow: box(".kbar .kgrow", ["font-size"]),
        tabs: box(".tabs", [...pad, "gap"]),
        tab: box(".tab", [...pad, "gap"]),
        sec: box(".sec", [...pad, "gap"]),
        secTitle: box(".sec b", ["font-size"]),
        row: box(".row", [...pad, "gap"]),
        name: box(".name", ["font-size", "font-weight"]),
        rowMeta: box(".row-meta", [...pad, "gap", "row-gap"]),
        rowFocus: box(".row-focus", [...pad, "gap", "font-size"]),
        focusSrc: box(".row-focus .focus-src", ["font-size"]),
        focusId: box(".row-focus .focus-id", ["font-size"]),
        badge: box(".ds-badge", [...pad, "font-size"]),
        init: box(".init", [...pad, "gap"]),
        initP: box(".init p", ["font-size", "line-height"]),
        initDim: box(".init .dim", ["font-size", "line-height"]),
        initBtn: box(".init-btn", [...pad, "gap", "margin-top", "font-size"]),
        overflow: { scrollW: de.scrollWidth, clientW: de.clientWidth, over: over.slice(0, 8) },
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
  const boot = Object.entries(v.boot)
    .filter(([key, val]) => key !== "initText" && key !== "initDim" && val)
    .map(([key]) => key)
    .join(",") || "ready-list";
  console.log(
    `${k.padEnd(32)} boot=${boot.padEnd(16)} initP ${v.initP?.["font-size"] ?? "—"}  name ${v.name?.["font-size"] ?? "—"}  row-pad ${v.row ? [v.row["padding-top"], v.row["padding-left"]].join("/") : "—"}  cards ${v.cards.withCard}/${v.cards.noCard}  overflow ${o.scrollW > o.clientW ? `YES ${o.scrollW}>${o.clientW} ${o.over.join(",")}` : "no"}`,
  );
}
