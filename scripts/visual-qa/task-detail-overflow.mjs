/**
 * `t-5564b4` — Visual QA gate for the Control Task Detail route.
 *
 * The route reached a human visibly broken while the preview catalog said nothing was wrong, because
 * the catalog held one fixture with no long refs, no attention and no long body. This asserts the
 * acceptance criterion the report is about — zero horizontal page overflow — across the content
 * shapes that actually break it, at the three widths the report names.
 *
 * Two properties make it worth trusting, both learned the hard way while writing it:
 *
 *  1. **`rendered` is checked BEFORE overflow.** The first version of this returned 12/12 green
 *     against a route that never mounted: an unrendered page trivially has no overflow. A gate whose
 *     precondition can be satisfied by absence measures nothing.
 *  2. **Content inside a scrollable ancestor is not overflow.** A `pre` with `overflow-x: auto` is
 *     the intended design; its children legitimately report a wider rect while being clipped to it.
 *
 * Prereq: `npm run build` and `npm run preview:webview` in another shell.
 * Run: `node scripts/visual-qa/task-detail-overflow.mjs`
 */
import puppeteer from "puppeteer-core";
const fixtures = ["task-detail", "task-detail-heavy", "task-detail-sparse", "task-detail-tombstone"];
const widths = [760, 1000, 1400];
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox","--disable-gpu"] });
let bad = 0;
for (const f of fixtures) for (const w of widths) {
  const p = await b.newPage();
  await p.setViewport({ width: w, height: 900 });
  await p.goto(`http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=${f}`, { waitUntil: "networkidle0", timeout: 45000 });
  await new Promise(r => setTimeout(r, 700));
  const m = await p.evaluate(() => {
    const de = document.documentElement;
    const root = document.querySelector(".td-root");
    // Content inside an element that scrolls itself is CLIPPED, not escaping — a `pre` with
    // overflow-x:auto is the intended design, and its children legitimately report a wider rect.
    const scrolls = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX; if (ox === "auto" || ox === "scroll" || ox === "hidden") return true; } return false; };
    const over = [...document.querySelectorAll(".td-root *")]
      .filter(e => e.getBoundingClientRect().right > de.clientWidth + 0.5 && !scrolls(e))
      .map(e => String(e.className).slice(0, 40));
    return { rendered: !!root, scrollW: de.scrollWidth, clientW: de.clientWidth, over: over.slice(0, 3) };
  });
  // The precondition FIRST: an unrendered route makes every overflow number meaningless.
  const ok = m.rendered && m.scrollW <= m.clientW && m.over.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${f} @${w} rendered=${m.rendered} scrollW=${m.scrollW} clientW=${m.clientW}${m.over.length ? " over=" + JSON.stringify(m.over) : ""}`);
  await p.close();
}
await b.close();
console.log(bad === 0 ? "\nVISUAL QA PASS — route rendered and zero horizontal overflow, 12/12" : `\nVISUAL QA FAIL — ${bad}/12`);
process.exit(bad ? 1 : 0);
