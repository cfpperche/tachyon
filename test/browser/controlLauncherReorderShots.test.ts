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
import { sortRows } from "@tachyon/webview-ui/sidebar/sortRows.js";
import { encodeLauncherCustom } from "@tachyon/webview-ui/sidebar/launcherOrder.js";

/**
 * t-539851 — headless Visual QA for the launcher grid's THREE sort modes plus the two
 * rearrange poses (idle-in-mode, dragging).
 *
 * Anchor, written from the task's problem statement BEFORE the shots: the launcher still reads as
 * the sidebar's phone home screen at a narrow and a wide width. Product order, A–Z, Z–A, and the
 * user's custom order are the same grid of tiles — only the sequence and the sort control's label
 * change. Entering rearrange mode does not add a frame or a second chrome: tiles tilt in place,
 * a Done control appears in the existing header slot, and a tile being dragged is the same cell
 * at a lower opacity, not a ghost from another toolkit. Evidence MUST go through tokens.css
 * (the real host links it); without it `.act.on` paints the same as `.act`.
 *
 * Not part of `verify:full` (needs system Chrome + built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/controlLauncherReorderShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-539851-launcher-reorder");
const DIST = EXTENSION_WEBVIEW_DIST;
const shotPage = path.join(DIST, "launcher-reorder-shot.html");

const WIDTHS = [
  { id: "narrow-360", px: 360 },
  { id: "wide-880", px: 880 },
];

type AppProps = {
  fleets?: FleetVM[];
  initialTab?: string;
  prefs?: { launcher?: string };
  initialReorderMode?: boolean;
  initialDraggingSection?: string;
};

const fleet: FleetVM = { ...SAMPLE, folder: { hash: "ws", name: "Project" } };
const product = CONTROL_SECTION_NAV.map((s) => s.id);
const custom = [...product].reverse();

type ShotState = {
  id: string;
  prefs?: { launcher: string };
  initialReorderMode?: boolean;
  initialDraggingSection?: string;
  expected: string[];
  buttonLabel: string;
  buttonOn: boolean;
  reorder: boolean;
  dragging?: string;
};

function pageHtml(body: string): string {
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  const tokens = readFileSync(path.join(DIST, "tokens.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  const theme = readFileSync(path.resolve(__dirname, "../../scripts/webview-preview/theme-dark.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${codicon}${tokens}${ds}${theme}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
/* Freeze jiggle so a screenshot is a pose, not a blur of an animation frame. The static tilt stays. */
.ctl-grid.is-reordering .ctl-tile.ds-btn { animation: none !important; }
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-539851 launcher reorder headless Visual QA", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: AppProps) => unknown;

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

  it("three modes plus idle-rearrange and dragging, at 360 and 880, through the tokens.css door", async () => {
    const states: ShotState[] = [
      {
        id: "product",
        expected: product,
        buttonLabel: "Sort launcher (Product order); click to sort A–Z",
        buttonOn: false,
        reorder: false,
      },
      {
        id: "name-asc",
        prefs: { launcher: "name-asc" },
        expected: sortRows(CONTROL_SECTION_NAV, "name-asc", (s) => s.label).map((s) => s.id),
        buttonLabel: "Sort launcher (Name (A–Z)); click to flip",
        buttonOn: true,
        reorder: false,
      },
      {
        id: "name-desc",
        prefs: { launcher: "name-desc" },
        expected: sortRows(CONTROL_SECTION_NAV, "name-desc", (s) => s.label).map((s) => s.id),
        buttonLabel: "Sort launcher (Name (Z–A)); click to flip",
        buttonOn: true,
        reorder: false,
      },
      {
        id: "custom",
        prefs: { launcher: encodeLauncherCustom(custom) },
        expected: custom,
        buttonLabel: "Sort launcher (Custom order); click to sort A–Z",
        buttonOn: true,
        reorder: false,
      },
      {
        id: "reorder-idle",
        prefs: { launcher: encodeLauncherCustom(custom) },
        initialReorderMode: true,
        expected: custom,
        buttonLabel: "Sort launcher (Custom order); click to sort A–Z",
        buttonOn: true,
        reorder: true,
      },
      {
        id: "dragging",
        prefs: { launcher: encodeLauncherCustom(custom) },
        initialReorderMode: true,
        initialDraggingSection: "system",
        expected: custom,
        buttonLabel: "Sort launcher (Custom order); click to sort A–Z",
        buttonOn: true,
        reorder: true,
        dragging: "system",
      },
    ];

    const buttonColors = new Map<string, string>();

    for (const state of states) {
      const html = renderStatic(App({
        fleets: [fleet],
        initialTab: "Control",
        prefs: state.prefs,
        initialReorderMode: state.initialReorderMode,
        initialDraggingSection: state.initialDraggingSection,
      }));

      for (const w of WIDTHS) {
        await page.setViewport({ width: w.px, height: 720, deviceScaleFactor: 1 });
        writeFileSync(shotPage, pageHtml(html));
        await page.goto(`file://${shotPage}`, { waitUntil: "networkidle0" });
        await page.evaluate(() => document.fonts.ready);

        const geom = await page.evaluate((want: { buttonLabel: string; dragging?: string }) => {
          const doc = document.documentElement;
          const grid = document.querySelector('[data-testid="control-grid"]');
          const sec = document.querySelector(".sec");
          const button = [...(sec?.querySelectorAll<HTMLButtonElement>("button.act") ?? [])].find((b) =>
            b.getAttribute("aria-label") === want.buttonLabel,
          );
          if (!grid || !sec) return { ok: false as const, reason: "missing nodes" };
          const tiles = [...grid.querySelectorAll(".ctl-tile")];
          const gr = grid.getBoundingClientRect();
          const dragged = want.dragging
            ? grid.querySelector<HTMLElement>(`.ctl-tile[data-section="${want.dragging}"]`)
            : null;
          const idle = tiles.find((t) => t !== dragged) ?? null;
          return {
            ok: true as const,
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
            order: tiles.map((t) => t.getAttribute("data-section")),
            tiles: tiles.length,
            sortButtonFound: !!button,
            sortButtonOn: button?.classList.contains("on") ?? false,
            sortButtonVisible: !!button && button.getBoundingClientRect().width > 0,
            sortButtonColor: button ? getComputedStyle(button).color : "",
            reorder: grid.getAttribute("data-reorder") === "true",
            doneVisible: !!document.querySelector('[data-testid="launcher-done"]'),
            tokensFocus: getComputedStyle(doc).getPropertyValue("--ds-focus").trim(),
            clippedLabels: tiles.filter((t) => {
              const label = t.querySelector(".ds-btn-label");
              return !label || label.scrollHeight > label.clientHeight + 1;
            }).length,
            overflowingTiles: tiles.filter((t) => t.getBoundingClientRect().right > gr.right + 1).length,
            draggedOpacity: dragged ? getComputedStyle(dragged).opacity : "",
            idleOpacity: idle ? getComputedStyle(idle).opacity : "",
            draggedHasClass: dragged?.classList.contains("is-dragging") ?? false,
          };
        }, { buttonLabel: state.buttonLabel, dragging: state.dragging });

        const where = `${state.id} @ ${w.px}px`;
        expect(geom.ok, `${where}: ${JSON.stringify(geom)}`).toBe(true);
        if (geom.ok) {
          expect(geom.tokensFocus, `${where}: tokens.css must define --ds-focus (the host door)`).not.toBe("");
          expect(geom.order, `${where}: the grid's DOM order matches the state`).toEqual(state.expected);
          expect(geom.tiles, `${where}: every launcher tile rendered`).toBe(CONTROL_SECTION_NAV.length);
          expect(geom.scrollWidth, `${where}: no horizontal scroll`).toBeLessThanOrEqual(geom.clientWidth + 1);
          expect(geom.clippedLabels, `${where}: no clipped tile label`).toBe(0);
          expect(geom.overflowingTiles, `${where}: no tile past the panel edge`).toBe(0);
          expect(geom.sortButtonFound, `${where}: the sort control is in the section header`).toBe(true);
          expect(geom.sortButtonVisible, `${where}: the sort control is visible`).toBe(true);
          expect(geom.sortButtonOn, `${where}: the control is lit only when a direction/custom is chosen`).toBe(state.buttonOn);
          expect(geom.reorder, `${where}: rearrange pose`).toBe(state.reorder);
          expect(geom.doneVisible, `${where}: Done only while rearranging`).toBe(state.reorder);
          if (state.dragging) {
            expect(geom.draggedHasClass, `${where}: the dragged tile is marked`).toBe(true);
            expect(Number(geom.draggedOpacity), `${where}: the dragged tile paints dimmer than its neighbours`).toBeLessThan(Number(geom.idleOpacity));
          }
          if (!buttonColors.has(state.id)) buttonColors.set(state.id, geom.sortButtonColor);
        }

        const png = await page.screenshot({ type: "png", fullPage: false });
        writeFileSync(path.join(OUT_DIR, `launcher-${state.id}-${w.id}.png`), png);
      }
    }

    expect(buttonColors.get("name-asc"), "the active sort control is painted with the focus color").not.toBe(buttonColors.get("product"));
    expect(buttonColors.get("name-desc")).not.toBe(buttonColors.get("product"));
    expect(buttonColors.get("custom"), "custom is a lit mode, not product order in a different label").not.toBe(buttonColors.get("product"));
  }, 120_000);
});
