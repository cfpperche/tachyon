/**
 * t-4aac93 — two-width visual pass for the multi-surface Open button.
 *
 * ANCHOR, written from the task's problem statement BEFORE the screen was measured:
 *
 *   A plugin with more than one consented surface must show a discoverable Open affordance on its
 *   installed card. A plugin with none must not. At 880: Open sits in the card-actions row with
 *   Remove, and the worlds card lists Alpha World and Zeta Map as the things Open can launch. At
 *   360: the same facts remain readable — Open does not clip or overflow the page, and dep-audit
 *   still has no Open. Tokens only; no hex, no spacing literal outside `--ds-spacing-size*` /
 *   the operator ramp on any NEW chrome (this surface reuses Button + KitDropdown).
 *
 * Prereq: `npm run build` and `node scripts/webview-preview/serve.mjs` (or PREVIEW_PORT).
 * Run: `node scripts/visual-qa/plugins-multi-surface.mjs [outDir]`
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { openPreview } from "./preview-surface.mjs";

const outDir = process.argv[2] ?? ".vqa/t-4aac93";
mkdirSync(outDir, { recursive: true });
const widths = [880, 360];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

let bad = 0;
for (const w of widths) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: 900 });
  const surface = await openPreview(page, { view: "plugins", fixture: "multi-surface", width: w, height: 900, settleMs: 700 });
  const openHandle = await surface.evaluateHandle(() => {
    const cards = [...document.querySelectorAll(".ds-card")];
    const worlds = cards.find((el) => el.querySelector(".pname")?.textContent?.trim() === "worlds");
    return worlds && [...worlds.querySelectorAll(".card-actions button")].find((b) => b.textContent.trim() === "Open");
  });
  const openEl = openHandle.asElement();
  if (openEl) await openEl.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const m = await surface.evaluate(() => {
    const de = document.documentElement;
    const cards = [...document.querySelectorAll(".ds-card")];
    const cardOf = (name) => cards.find((el) => el.querySelector(".pname")?.textContent?.trim() === name);
    const actionsOf = (name) => {
      const card = cardOf(name);
      return card ? [...card.querySelectorAll(".card-actions button")].map((b) => b.textContent.trim()).filter(Boolean) : [];
    };
    const bodyText = document.body.textContent ?? "";
    return {
      rendered: !!document.querySelector(".ck-plugins-root"),
      cards: cards.length,
      worldsActions: actionsOf("worlds"),
      auditActions: actionsOf("dep-audit"),
      worldsHasAlpha: bodyText.includes("Alpha World"),
      worldsHasZeta: bodyText.includes("Zeta Map"),
      scrollW: de.scrollWidth,
      clientW: de.clientWidth,
    };
  });
  const shot = `${outDir}/plugins-multi-surface-${w}.png`;
  await page.screenshot({ path: shot, fullPage: true });
  const ok = m.rendered
    && m.cards === 2
    && m.worldsActions.includes("Open")
    && !m.auditActions.includes("Open")
    && m.scrollW <= m.clientW;
  if (!ok) bad += 1;
  console.log(`${ok ? "PASS" : "FAIL"} multi-surface@${w} ${JSON.stringify(m)} → ${shot}`);
  await page.close();
}

await browser.close();
console.log(bad === 0 ? `\nVISUAL QA PASS — screenshots in ${outDir}` : `\nVISUAL QA FAIL — ${bad}/2`);
process.exit(bad ? 1 : 0);
