import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { type FleetVM } from "@tachyon/shared/sidebar/types.js";
import { SAMPLE } from "../../scripts/webview-preview/fixtures/sidebar.js";
import { CONTROL_SECTION_NAV } from "@tachyon/webview-ui/webview/sidebar/sectionNav.js";
import { sortRows, type SortMode } from "@tachyon/webview-ui/sidebar/sortRows.js";
import { encodeLauncherCustom } from "@tachyon/webview-ui/sidebar/launcherOrder.js";

/**
 * t-50daeb metade 1 — headless Visual QA for the launcher grid's SORT states.
 *
 * The anchor, written from the task's problem statement before the shots: the launcher keeps its
 * phone-home-screen reading while offering the Agents tab's A–Z flip — in BOTH directions and at a
 * narrow and a wide sidebar width, every tile stays legible (no clipped label, no tile past the
 * panel edge, no horizontal scroll), the sort control sits in the section header with its state
 * visible with the same white paint as Agents, while its changing glyph carries the state, and the
 * grid's order matches the chosen direction. The PRODUCT order stays what a person without a
 * preference sees. Product, A-Z, custom, and Agents controls appear together in each comparison shot.
 *
 * Not part of `verify:full` (needs system Chrome + built `dist/`), same as t-6e2952's shots.
 * Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/controlLauncherSortShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-50daeb-launcher-sort");
const DIST = EXTENSION_WEBVIEW_DIST;
/** build artifact, not a source file: the shot page lives beside the CSS it links (see the goto below). */
const shotPage = path.join(DIST, "launcher-sort-shot.html");

// Narrow (a person dragging the sidebar in — same as t-6e2952's narrow) and a wide sidebar, which
// is where the grid gains columns and a wrong sort is easiest to SEE. One width hides the class of
// defect worth catching: labels that only clip once the cells get tight.
const WIDTHS = [
  { id: "narrow-360", px: 360 },
  { id: "wide-880", px: 880 },
];

type SortState = { id: string; prefs?: { launcher: string }; expected: string[]; buttonLabel: string };

const fleet: FleetVM = { ...SAMPLE, folder: { hash: "ws", name: "Project" } };

function pageHtml(body: string): string {
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  // tokens.css is linked by the REAL host (SidebarPrototype resolveWebviewView) and defines --ds-focus,
  // which the sort control's lit state is painted with — a shot page without it measures the control's
  // two states as the same color (found while checking the evidence: `.act.on` computed #ccc without it).
  const tokens = readFileSync(path.join(DIST, "tokens.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  // The preview harness's own dark --vscode-* palette: without it the shot loses every token the
  // tiles are painted with and judges a screen nobody has.
  const theme = readFileSync(path.resolve(__dirname, "../../scripts/webview-preview/theme-dark.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${codicon}${tokens}${ds}${theme}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-50daeb launcher sort headless Visual QA", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: { fleets?: FleetVM[]; initialTab?: string; prefs?: { launcher?: string } }) => unknown;

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const mod = await loadWebviewModule(path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"));
    App = mod.App as typeof App;
    browser = await puppeteer.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    rmSync(shotPage, { force: true });
  });

  it("every sort state reads as the same launcher and paints like Agents at 360 and 880", async () => {
    const custom = [...CONTROL_SECTION_NAV.map((s) => s.id)].reverse();
    const states: SortState[] = [
      {
        id: "product",
        prefs: undefined,
        expected: CONTROL_SECTION_NAV.map((s) => s.id),
        buttonLabel: "Sort launcher (Product order); click to sort A–Z",
      },
      ...(["name-asc", "name-desc"] as SortMode[]).map((mode) => ({
        id: mode,
        prefs: { launcher: mode },
        expected: sortRows(CONTROL_SECTION_NAV, mode, (s) => s.label).map((s) => s.id),
        buttonLabel: `Sort launcher (${mode === "name-asc" ? "Name (A–Z)" : "Name (Z–A)"}); click to flip`,
      })),
      {
        id: "custom",
        prefs: { launcher: encodeLauncherCustom(custom) },
        expected: custom,
        buttonLabel: "Sort launcher (Custom order); click to sort A–Z",
      },
    ];

    const buttonColors = new Map<string, string>();

    for (const state of states) {
      const html = renderStatic(App({ fleets: [fleet], initialTab: "Control" as never, prefs: state.prefs }));

      for (const w of WIDTHS) {
        await page.setViewport({ width: w.px, height: 720, deviceScaleFactor: 1 });
        // Served FROM dist/webview (not setContent) so codicon.css's relative font url resolves.
        writeFileSync(shotPage, pageHtml(html));
        await page.goto(`file://${shotPage}`, { waitUntil: "networkidle0" });
        await page.evaluate(() => document.fonts.ready);

        const geom = await page.evaluate((want: { buttonLabel: string }) => {
          const doc = document.documentElement;
          const grid = document.querySelector('[data-testid="control-grid"]');
          const sec = document.querySelector(".sec");
          const button = [...(sec?.querySelectorAll<HTMLButtonElement>("button.act") ?? [])].find((b) =>
            b.getAttribute("aria-label") === want.buttonLabel,
          );
          if (!grid || !sec) return { ok: false as const, reason: "missing nodes" };
          const tiles = [...grid.querySelectorAll(".ctl-tile")];
          const gr = grid.getBoundingClientRect();
          return {
            ok: true as const,
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
            order: tiles.map((t) => t.getAttribute("data-section")),
            tiles: tiles.length,
            sortButtonFound: !!button,
            sortButtonOn: button?.classList.contains("on") ?? false,
            sortButtonVisible: !!button && button.getBoundingClientRect().width > 0,
            // Found the hard way: with tokens.css missing from the shot page, `.act.on` computes the
            // SAME muted color as the off state and the lit control is invisible. Assert the paint,
            // not just the class — a class that paints nothing is not a state.
            sortButtonColor: button ? getComputedStyle(button).color : "",
            // every tile's label is fully rendered, never clipped to an unreadable stub
            clippedLabels: tiles.filter((t) => {
              const label = t.querySelector(".ds-btn-label");
              return !label || label.scrollHeight > label.clientHeight + 1;
            }).length,
            // tiles stay inside the panel's box (no cell spilling past the sidebar edge)
            overflowingTiles: tiles.filter((t) => t.getBoundingClientRect().right > gr.right + 1).length,
          };
        }, { buttonLabel: state.buttonLabel });

        const where = `${state.id} @ ${w.px}px`;
        expect(geom.ok, `${where}: ${JSON.stringify(geom)}`).toBe(true);
        if (geom.ok) {
          expect(geom.order, `${where}: the grid's DOM order matches the state`).toEqual(state.expected);
          expect(geom.tiles, `${where}: every launcher tile rendered`).toBe(CONTROL_SECTION_NAV.length);
          expect(geom.scrollWidth, `${where}: no horizontal scroll`).toBeLessThanOrEqual(geom.clientWidth + 1);
          expect(geom.clippedLabels, `${where}: no clipped tile label`).toBe(0);
          expect(geom.overflowingTiles, `${where}: no tile past the panel edge`).toBe(0);
          expect(geom.sortButtonFound, `${where}: the sort control is in the section header`).toBe(true);
          expect(geom.sortButtonVisible, `${where}: the sort control is visible`).toBe(true);
          expect(geom.sortButtonOn, `${where}: glyph, not the shared active color, carries sort state`).toBe(false);
          if (!buttonColors.has(state.id)) buttonColors.set(state.id, geom.sortButtonColor);
        }

        const png = await page.screenshot({ type: "png", fullPage: false });
        writeFileSync(path.join(OUT_DIR, `launcher-${state.id}-${w.id}.png`), png);
      }
    }

    // The glyph already distinguishes direction and custom order (gripper), so color does not repeat
    // that state. Keep measuring computed paint through tokens.css: otherwise equality could pass by
    // accident on a capture page unable to resolve the real focus token.
    expect(buttonColors.get("name-asc"), "A-Z uses the same white paint as product order").toBe(buttonColors.get("product"));
    expect(buttonColors.get("name-desc"), "Z-A uses the same white paint as product order").toBe(buttonColors.get("product"));
    expect(buttonColors.get("custom"), "custom order uses the same white paint as product order").toBe(buttonColors.get("product"));

    const comparisonBodies = [
      ...states.filter((state) => state.id === "product" || state.id === "name-asc" || state.id === "custom").map((state) => ({
        label: `Launcher — ${state.id}`,
        html: renderStatic(App({ fleets: [fleet], initialTab: "Control" as never, prefs: state.prefs })),
      })),
      { label: "Agents — A-Z", html: renderStatic(App({ fleets: [fleet], initialTab: "Agents" as never })) },
    ];
    for (const w of WIDTHS) {
      await page.setViewport({ width: w.px, height: 720, deviceScaleFactor: 1 });
      const cards = comparisonBodies.map(({ label, html }) => `<section class="comparison-card"><h2>${label}</h2>${html}</section>`).join("");
      writeFileSync(shotPage, pageHtml(`<main class="comparison-grid">${cards}</main>`).replace("</style>", `
.comparison-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:8px}
.comparison-card{min-width:0;border:1px solid var(--vscode-panel-border,#444);overflow:hidden}
.comparison-card h2{margin:0;padding:6px 8px;font:600 11px/1.2 var(--vscode-font-family,system-ui);color:var(--vscode-descriptionForeground,#aaa)}
@media(max-width:600px){.comparison-grid{grid-template-columns:1fr}.comparison-card{height:160px}}
</style>`));
      await page.goto(`file://${shotPage}`, { waitUntil: "networkidle0" });
      await page.evaluate(() => document.fonts.ready);
      const comparisonColors = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".comparison-card")].map((card) => ({
        label: card.querySelector("h2")?.textContent ?? "unknown",
        color: getComputedStyle(card.querySelector<HTMLButtonElement>('button.act[title^="Sort"]')!).color,
      })));
      expect(new Set(comparisonColors.map(({ color }) => color)).size,
        `${w.px}px: launcher product, A-Z, custom, and Agents controls share paint: ${JSON.stringify(comparisonColors)}`)
        .toBe(1);
      const png = await page.screenshot({ type: "png", fullPage: false });
      writeFileSync(path.join(OUT_DIR, `launcher-agents-comparison-${w.id}.png`), png);
    }
  }, 120_000);
});
