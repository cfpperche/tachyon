import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, type FleetVM } from "../../src/sidebar/types.js";
import { CONTROL_SECTION_NAV } from "../../src/cockpit/sectionNav.js";

/**
 * t-6e2952 — headless Visual QA for the Control TAB (the launcher grid inside the one sidebar panel).
 *
 * The anchor, written from the task's problem statement before the grid existed: a person opening the
 * second tab sees ONE panel that still reads as the Tachyon sidebar — same tab strip, same section
 * label, same borderless hover language as the lists — carrying a phone-home-screen grid of Control's
 * twelve sections. Nothing stacked above it, nothing framed like an embedded widget, no label truncated
 * to a stub, and no horizontal scroll at any sidebar width a person can drag to.
 *
 * Not part of `verify:full` (needs system Chrome + built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/controlTabShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-6e2952-control-tab");
const DIST = path.resolve(__dirname, "../../dist/webview");
/** build artifact, not a source file: the shot page lives beside the CSS it links (see the goto below). */
const shotPage = path.join(DIST, "control-tab-shot.html");

// Narrow (a person dragging the sidebar in) and the normal sidebar width. A single width hides exactly
// the defect worth catching here: a grid whose per-cell labels collapse once the columns get tight.
const WIDTHS = [
  { id: "220", px: 220 },
  { id: "normal-340", px: 340 },
];

const fleet: FleetVM = { ...SAMPLE, folder: { hash: "ws", name: "Project" } };

function pageHtml(body: string): string {
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  // The preview harness's own dark --vscode-* palette: without it the shot loses every token the tiles
  // are painted with (the icon plate is a color-mix on --vscode-foreground) and judges a screen nobody has.
  const theme = readFileSync(path.resolve(__dirname, "../../scripts/webview-preview/theme-dark.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${codicon}${ds}${theme}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-6e2952 Control tab headless Visual QA", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: { fleets?: FleetVM[]; initialTab?: string }) => unknown;

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const mod = await loadWebviewModule(path.resolve(__dirname, "../../src/webview/sidebar/App.tsx"));
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

  it("the grid is one panel, in the tab row, legible at 220 and 340", async () => {
    const html = renderStatic(App({ fleets: [fleet], initialTab: "Control" as never }));

    for (const w of WIDTHS) {
      await page.setViewport({ width: w.px, height: 720, deviceScaleFactor: 1 });
      // Served FROM dist/webview (not setContent) so codicon.css's relative font url resolves — the
      // whole point of this surface is its icons; a shot of empty tiles proves nothing about it.
      writeFileSync(shotPage, pageHtml(html));
      await page.goto(`file://${shotPage}`, { waitUntil: "networkidle0" });
      await page.evaluate(() => document.fonts.ready);

      const geom = await page.evaluate(() => {
        const doc = document.documentElement;
        const tabs = document.querySelector(".tabs");
        const grid = document.querySelector('[data-testid="control-grid"]');
        const panel = document.getElementById("sidebar-panel");
        if (!tabs || !grid || !panel) return { ok: false as const, reason: "missing nodes" };
        const tiles = [...grid.querySelectorAll(".ctl-tile")];
        const gr = grid.getBoundingClientRect();
        return {
          ok: true as const,
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          // the grid renders INSIDE the single tabpanel, below the strip — never a second stacked panel.
          insideTabPanel: panel.contains(grid),
          belowTabs: gr.top >= tabs.getBoundingClientRect().bottom,
          tabCount: document.querySelectorAll(".tabs .tab").length,
          controlTabIndex: [...document.querySelectorAll(".tabs .tab")].findIndex((t) => t.id === "tab-Control"),
          tiles: tiles.length,
          // every tile's label is fully rendered, never clipped to an unreadable stub
          clippedLabels: tiles.filter((t) => {
            const label = t.querySelector(".ds-btn-label");
            return !label || label.scrollHeight > label.clientHeight + 1;
          }).length,
          // tiles stay inside the panel's box (no cell spilling past the sidebar edge)
          overflowingTiles: tiles.filter((t) => t.getBoundingClientRect().right > gr.right + 1).length,
        };
      });

      expect(geom.ok, `control grid geometry at ${w.px}: ${JSON.stringify(geom)}`).toBe(true);
      if (geom.ok) {
        expect(geom.scrollWidth, `no horizontal scroll at ${w.px}px`).toBeLessThanOrEqual(geom.clientWidth + 1);
        expect(geom.insideTabPanel, `grid must live in the one tabpanel at ${w.px}px`).toBe(true);
        expect(geom.belowTabs, `grid must sit below the tab strip at ${w.px}px`).toBe(true);
        expect(geom.controlTabIndex, `Control is the second tab at ${w.px}px`).toBe(1);
        expect(geom.tiles, `twelve section tiles at ${w.px}px`).toBe(CONTROL_SECTION_NAV.length);
        expect(geom.clippedLabels, `no clipped tile label at ${w.px}px`).toBe(0);
        expect(geom.overflowingTiles, `no tile past the panel edge at ${w.px}px`).toBe(0);
      }

      const png = await page.screenshot({ type: "png", fullPage: false });
      writeFileSync(path.join(OUT_DIR, `control-tab-${w.id}.png`), png);
    }
  }, 120_000);
});
