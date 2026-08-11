/**
 * t-475b9b — the two-width visual pass on Agent Studio AFTER the self-evolution removal (`1d637f46`).
 *
 * ANCHOR, written from the task's problem statement BEFORE any screenshot was taken (an anchor
 * written afterwards only proves the screenshot matches itself):
 *
 *   `EvolutionSection` used to render between the persistent-instructions `<section>` and the
 *   Auto-start / Restart-on-crash / Attention check grid, and the profile provenance grid used to
 *   carry FOUR cards — the fourth being "Learned state", fed exclusively by `prompt.evolution`.
 *   Both are gone. What the human must see now is a form that reads as CONTINUOUS at the seam:
 *
 *     - no empty region where the section stood (no visible box, border or background enclosing
 *       nothing);
 *     - no orphan heading or stranded control left behind by the cut;
 *     - no doubled vertical gap — the seam between "Persistent instructions" and the check grid must
 *       measure like every other gap between siblings in the same column, not like two of them;
 *     - the provenance grid still reads as a deliberate row of three, not a row of four with a hole;
 *     - and at 360 nothing overflows sideways.
 *
 *   What must NOT change: everything else on the screen. This is a pass, not a redesign.
 *
 * The measurements that stand for that anchor, taken inside the surface frame:
 *   `seam`      — the gap between the persistent-instructions section and the next sibling, next to
 *                 the median gap of the same column. A hole shows up as an outlier here.
 *   `emptyBoxes`— visible elements with a border/background, tall enough to see, holding no text and
 *                 no sized descendant. That is what "a card border closing on nothing" looks like.
 *   `evolutionResidue` — any surviving id/class/testid/text naming evolution, and the count of
 *                 provenance cards.
 *   `overflow`  — the surface's horizontal scroll, which is the defect 360 exists to catch.
 *
 * Prereq: `node esbuild.mjs` and `node scripts/webview-preview/serve.mjs` (PREVIEW_PORT respected).
 * Run: `node scripts/visual-qa/agent-studio-evolution-removal.mjs [outDir] [label]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { openPreview } from "./preview-surface.mjs";

const outDir = process.argv[2] ?? ".vqa/t-475b9b";
const label = process.argv[3] ?? "shot";
mkdirSync(outDir, { recursive: true });

const widths = [880, 360];
const routes = [
  { fixture: "new", note: "new agent, canonical shape (t-547771)" },
  { fixture: "canonical-disabled", note: "EXISTING agent with a saved canonical profile" },
  { fixture: "dense-edit", note: "EXISTING agent, legacy storage (no profile card)" },
  { fixture: "load-error", note: "load failure shows the error (t-f4e186)" },
];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

/** Runs INSIDE the surface frame. Returns the anchor's measurements for one route × width. */
const probe = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) };
  };

  // --- the seam: siblings of the form column, in document order ---
  const column = document.querySelector(".ash-fields") ?? document.querySelector("#root");
  const kids = column ? [...column.children].filter(vis) : [];
  const gaps = [];
  for (let i = 1; i < kids.length; i++) {
    const prev = kids[i - 1].getBoundingClientRect();
    const next = kids[i].getBoundingClientRect();
    gaps.push({
      after: (kids[i - 1].className || kids[i - 1].tagName).toString().slice(0, 60),
      before: (kids[i].className || kids[i].tagName).toString().slice(0, 60),
      gap: Math.round(next.top - prev.bottom),
    });
  }
  const sorted = gaps.map((g) => g.gap).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  // The seam the removal created: the gap that follows the persistent-instructions section.
  const instructionsIdx = kids.findIndex((k) => /Persistent instructions|persistent instructions/i.test(k.textContent ?? ""));
  const seam = instructionsIdx >= 0 && instructionsIdx < gaps.length ? gaps[instructionsIdx] : null;

  // --- empty boxes: a visible container with chrome, no text and no sized child ---
  const emptyBoxes = [];
  for (const el of document.querySelectorAll("#root *")) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 16) continue;
    const cs = getComputedStyle(el);
    const hasChrome =
      cs.borderTopWidth !== "0px" || cs.borderBottomWidth !== "0px" ||
      cs.borderLeftWidth !== "0px" || cs.borderRightWidth !== "0px" ||
      (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent");
    if (!hasChrome) continue;
    if ((el.textContent ?? "").trim().length > 0) continue;
    const sizedChild = [...el.querySelectorAll("*")].some((c) => {
      const cr = c.getBoundingClientRect();
      return cr.width > 4 && cr.height > 4;
    });
    if (sizedChild) continue;
    if (["INPUT", "TEXTAREA", "SELECT", "HR", "IMG", "svg"].includes(el.tagName)) continue;
    emptyBoxes.push({ tag: el.tagName, cls: (el.className || "").toString().slice(0, 60), ...box(el) });
  }

  // --- evolution residue anywhere on the surface ---
  const attrHits = [...document.querySelectorAll("#root *")]
    .filter((el) => /evolution/i.test(`${el.id} ${(el.className || "").toString()} ${el.getAttribute("data-testid") ?? ""}`))
    .map((el) => ({ tag: el.tagName, cls: (el.className || "").toString().slice(0, 60), id: el.id }));
  const textHit = /evolution|learned state/i.test(document.body.innerText ?? "");

  return {
    seam,
    medianGap: median,
    gaps,
    emptyBoxes,
    evolutionResidue: { attrHits, textHit },
    provenanceCards: [...document.querySelectorAll(".ash-profile-source")].map((c) =>
      (c.querySelector("strong")?.textContent ?? "").trim(),
    ),
    checkGridPresent: !!document.querySelector(".ash-check-grid"),
    surfaceWidth: document.documentElement.clientWidth,
    contentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    rootText: (document.body.innerText ?? "").slice(0, 400),
  };
};

const report = [];

for (const route of routes) {
  for (const w of widths) {
    // Pass 1 at the product's own viewport height, to learn how tall the form actually is.
    const probePage = await browser.newPage();
    await probePage.setViewport({ width: w + 20, height: 900 });
    let surface = await openPreview(probePage, { view: "agent-studio-shell", fixture: route.fixture, width: w, height: 900, settleMs: 200 });
    const first = await surface.evaluate(probe);
    await probePage.close();

    // Pass 2 with the frame grown to the content, so ONE image carries the whole column and a hole
    // cannot hide below the fold. Layout at a given width is unchanged by a taller frame.
    const tall = Math.min(Math.max(first.contentHeight + 40, 900), 4200);
    const page = await browser.newPage();
    await page.setViewport({ width: w + 20, height: tall });
    surface = await openPreview(page, { view: "agent-studio-shell", fixture: route.fixture, width: w, height: tall, settleMs: 250 });
    const measured = await surface.evaluate(probe);
    const file = `${outDir}/${label}-${route.fixture}-${w}.png`;
    await page.screenshot({ path: file, fullPage: true });
    await page.close();

    report.push({ fixture: route.fixture, note: route.note, width: w, file, viewportHeight: tall, ...measured });
    console.error(`captured ${route.fixture} @ ${w} -> ${file}`);
  }
}

await browser.close();

writeFileSync(`${outDir}/${label}-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    report.map((r) => ({
      fixture: r.fixture,
      width: r.width,
      seam: r.seam,
      medianGap: r.medianGap,
      emptyBoxes: r.emptyBoxes.length,
      residue: r.evolutionResidue.attrHits.length + (r.evolutionResidue.textHit ? 1 : 0),
      provenanceCards: r.provenanceCards,
      overflow: r.overflow,
    })),
    null,
    2,
  ),
);
