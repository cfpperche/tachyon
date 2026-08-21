import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { type FleetVM } from "@tachyon/shared/sidebar/types.js";
import { SAMPLE } from "../../scripts/webview-preview/fixtures/sidebar.js";
import { CONTROL_SECTION_NAV } from "@tachyon/webview-ui/webview/sidebar/sectionNav.js";
import { encodeLauncherCustom, moveLauncherTile } from "@tachyon/webview-ui/sidebar/launcherOrder.js";

/**
 * t-5b84bb — drive the launcher drag and assert the insertion slot is visible BEFORE drop.
 *
 * Anchor, written from the task's problem statement BEFORE the shots: during rearrange, dragging a
 * tile must show where it will land before release. Neighbors shift so an empty outlined cell sits
 * at the insertion index (the iOS property measured in t-50daeb journal j-17fe571d1194). That slot
 * hides its own label, so captions cannot stack under the ghost. Persist still happens only on drop;
 * dragend without drop, or Escape, restores the origin order and writes nothing. Evidence MUST go
 * through tokens.css (the real host links it); without it the slot outline cannot be distinguished
 * from a missing token.
 *
 * A static screenshot cannot drag, and a test that only checks the final order would not see this
 * defect: the final order is already correct today. The first test therefore mounts the real App
 * with real Preact hooks and fires dragstart/dragover.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-5b84bb-launcher-drop-slot");
const DIST = EXTENSION_WEBVIEW_DIST;
const shotPage = path.join(DIST, "launcher-drop-slot-shot.html");
const product = CONTROL_SECTION_NAV.map((s) => s.id);
const fleet: FleetVM = { ...SAMPLE, folder: { hash: "ws", name: "Project" } };
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
  initialDropTarget?: string;
  dispatch?: { setSort?: (section: string, mode: string) => void };
};

function pageCss(): string {
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  const tokens = readFileSync(path.join(DIST, "tokens.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  const theme = readFileSync(path.resolve(__dirname, "../../scripts/webview-preview/theme-dark.css"), "utf8");
  return `${codicon}${tokens}${ds}${theme}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
.ctl-grid.is-reordering .ctl-tile.ds-btn { animation: none !important; }`;
}

function pageHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><style>${pageCss()}</style></head>
<body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

async function bundleLiveHarness(): Promise<string> {
  const appEntry = path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx");
  const sampleEntry = path.resolve(__dirname, "../../scripts/webview-preview/fixtures/sidebar.ts");
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { render, h } from "preact";
        import { App } from ${JSON.stringify(appEntry)};
        import { SAMPLE } from ${JSON.stringify(sampleEntry)};
        const root = document.getElementById("root");
        window.__sorts = [];
        const fleet = { ...SAMPLE, folder: { hash: "ws", name: "Project" } };
        const dispatch = { setSort: (section, mode) => window.__sorts.push([section, mode]) };
        window.__render = () => render(h(App, {
          fleets: [fleet],
          initialTab: "Control",
          initialReorderMode: true,
          dispatch,
        }), root);
        window.__resetSorts = () => { window.__sorts = []; };
      `,
      resolveDir: path.resolve(__dirname, "../.."),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "preact",
    write: false,
  });
  return built.outputFiles[0].text;
}

type DragSnapshot = {
  dropAt: string | null;
  order: Array<string | null>;
  slotId: string | null;
  slotLabelHidden: boolean;
  overlappingLabels: number;
  sorts: Array<[string, string]>;
};

async function snapshot(page: Page): Promise<DragSnapshot> {
  return page.evaluate(() => {
    const grid = document.querySelector('[data-testid="control-grid"]');
    const tiles = [...(grid?.querySelectorAll(".ctl-tile") ?? [])];
    const slot = grid?.querySelector<HTMLElement>("[data-drop-slot='true']");
    const slotLabel = slot?.querySelector<HTMLElement>(".ds-btn-label");
    const visibleLabels = tiles.flatMap((t) => {
      const label = t.querySelector<HTMLElement>(".ds-btn-label");
      if (!label) return [];
      const cs = getComputedStyle(label);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return [];
      return [label.getBoundingClientRect()];
    });
    let overlappingLabels = 0;
    for (let i = 0; i < visibleLabels.length; i++) {
      for (let j = i + 1; j < visibleLabels.length; j++) {
        const a = visibleLabels[i]!;
        const b = visibleLabels[j]!;
        const hit = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        if (hit) overlappingLabels++;
      }
    }
    return {
      dropAt: grid?.getAttribute("data-drop-at") ?? null,
      order: tiles.map((t) => t.getAttribute("data-section")),
      slotId: slot?.getAttribute("data-section") ?? null,
      slotLabelHidden: slotLabel ? getComputedStyle(slotLabel).visibility === "hidden" : false,
      overlappingLabels,
      sorts: (window as unknown as { __sorts: Array<[string, string]> }).__sorts.slice(),
    };
  });
}

async function paintLive(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __resetSorts: () => void }).__resetSorts();
    (window as unknown as { __render: () => void }).__render();
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function driveOver(page: Page, fromId: string, toId: string): Promise<void> {
  await page.evaluate(({ fromId, toId }) => {
    const from = document.querySelector(`[data-section="${fromId}"]`);
    const to = document.querySelector(`[data-section="${toId}"]`);
    if (!from || !to) throw new Error(`missing tile ${fromId} or ${toId}`);
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    (window as unknown as { __dt: DataTransfer }).__dt = dt;
  }, { fromId, toId });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

describe("t-5b84bb launcher drop slot — drive the drag, then the pose", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: AppProps) => unknown;
  let liveScript: string;

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const mod = await loadWebviewModule(path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"));
    App = mod.App as typeof App;
    liveScript = await bundleLiveHarness();
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

  it("dragover shows the insertion slot before drop, and drop is what writes custom:", async () => {
    await page.setViewport({ width: 880, height: 720, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"/><style>${pageCss()}</style></head>
<body class="vscode-dark"><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: liveScript });
    await paintLive(page);
    await driveOver(page, "settings", "design-mode");

    const before = await snapshot(page);
    expect(before.sorts, "setSort must not fire on dragover — the final order is already correct today").toEqual([]);
    expect(before.dropAt, "the grid names the insertion id during drag").toBe("design-mode");
    expect(before.slotId, "the dragged cell is the empty slot at the insertion index").toBe("settings");
    expect(before.slotLabelHidden, "the slot hides its label so captions cannot stack").toBe(true);
    expect(before.order).toEqual(moveLauncherTile(product, "settings", "design-mode"));
    expect(before.overlappingLabels, "no two visible tile labels overlap while the slot is showing").toBe(0);

    await page.evaluate(() => {
      const to = document.querySelector('[data-section="design-mode"]');
      const dt = (window as unknown as { __dt: DataTransfer }).__dt;
      to?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const after = await snapshot(page);
    expect(after.sorts).toEqual([["launcher", encodeLauncherCustom(moveLauncherTile(product, "settings", "design-mode"))]]);
  });

  it("dragend without drop writes nothing and restores origin order", async () => {
    await page.setViewport({ width: 880, height: 720, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"/><style>${pageCss()}</style></head>
<body class="vscode-dark"><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: liveScript });
    await paintLive(page);
    await driveOver(page, "settings", "design-mode");
    const mid = await snapshot(page);
    expect(mid.dropAt).toBe("design-mode");
    expect(mid.sorts).toEqual([]);

    await page.evaluate(() => {
      const from = document.querySelector('[data-section="settings"]');
      const dt = (window as unknown as { __dt: DataTransfer }).__dt;
      from?.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const after = await snapshot(page);
    expect(after.sorts).toEqual([]);
    expect(after.order).toEqual(product);
    expect(after.dropAt).toBeNull();
  });

  it("Escape during drag writes nothing and restores origin order", async () => {
    await page.setViewport({ width: 880, height: 720, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"/><style>${pageCss()}</style></head>
<body class="vscode-dark"><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: liveScript });
    await paintLive(page);
    await driveOver(page, "settings", "design-mode");
    expect((await snapshot(page)).sorts).toEqual([]);

    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const after = await snapshot(page);
    expect(after.sorts).toEqual([]);
    expect(after.order).toEqual(product);
    expect(after.dropAt).toBeNull();
  });

  it("insertion pose at 360 and 880 through the tokens.css door", async () => {
    const expected = moveLauncherTile(product, "settings", "design-mode");
    const html = renderStatic(App({
      fleets: [fleet],
      initialTab: "Control",
      initialReorderMode: true,
      initialDraggingSection: "settings",
      initialDropTarget: "design-mode",
    }));

    for (const w of WIDTHS) {
      await page.setViewport({ width: w.px, height: 720, deviceScaleFactor: 1 });
      writeFileSync(shotPage, pageHtml(html));
      await page.goto(`file://${shotPage}`, { waitUntil: "networkidle0" });
      await page.evaluate(() => document.fonts.ready);

      const geom = await page.evaluate(() => {
        const doc = document.documentElement;
        const grid = document.querySelector('[data-testid="control-grid"]');
        if (!grid) return { ok: false as const, reason: "missing grid" };
        const tiles = [...grid.querySelectorAll(".ctl-tile")];
        const slot = grid.querySelector<HTMLElement>("[data-drop-slot='true']");
        const slotLabel = slot?.querySelector<HTMLElement>(".ds-btn-label");
        const probe = document.createElement("div");
        probe.style.color = "var(--ds-focus)";
        document.body.appendChild(probe);
        const focusAsColor = getComputedStyle(probe).color;
        probe.remove();
        const visibleLabels = tiles.flatMap((t) => {
          const label = t.querySelector<HTMLElement>(".ds-btn-label");
          if (!label) return [];
          const cs = getComputedStyle(label);
          if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return [];
          return [label.getBoundingClientRect()];
        });
        let overlappingLabels = 0;
        for (let i = 0; i < visibleLabels.length; i++) {
          for (let j = i + 1; j < visibleLabels.length; j++) {
            const a = visibleLabels[i]!;
            const b = visibleLabels[j]!;
            const hit = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
            if (hit) overlappingLabels++;
          }
        }
        return {
          ok: true as const,
          tokensFocus: getComputedStyle(doc).getPropertyValue("--ds-focus").trim(),
          order: tiles.map((t) => t.getAttribute("data-section")),
          dropAt: grid.getAttribute("data-drop-at"),
          slotId: slot?.getAttribute("data-section") ?? null,
          slotLabelHidden: slotLabel ? getComputedStyle(slotLabel).visibility === "hidden" : false,
          slotOutline: slot ? getComputedStyle(slot).outlineStyle : "",
          slotOutlineColor: slot ? getComputedStyle(slot).outlineColor : "",
          focusAsColor,
          overlappingLabels,
          doneVisible: !!document.querySelector('[data-testid="launcher-done"]'),
        };
      });

      const where = `dragging-settings-onto-design-mode @ ${w.px}px`;
      expect(geom.ok, `${where}: ${JSON.stringify(geom)}`).toBe(true);
      if (geom.ok) {
        expect(geom.tokensFocus, `${where}: tokens.css must define --ds-focus`).not.toBe("");
        expect(geom.doneVisible, `${where}: Done stays the rearrange exit`).toBe(true);
        expect(geom.dropAt, `${where}: insertion id is visible on the grid`).toBe("design-mode");
        expect(geom.slotId, `${where}: Settings is the empty slot`).toBe("settings");
        expect(geom.order, `${where}: neighbors have shifted around the slot`).toEqual(expected);
        expect(geom.slotLabelHidden, `${where}: the slot's label is not painted`).toBe(true);
        expect(geom.slotOutline, `${where}: the slot is a dashed insertion mark`).toBe("dashed");
        expect(geom.slotOutlineColor, `${where}: slot outline is --ds-focus`).toBe(geom.focusAsColor);
        expect(geom.overlappingLabels, `${where}: no label-on-label`).toBe(0);
      }

      const png = await page.screenshot({ type: "png", fullPage: false });
      writeFileSync(path.join(OUT_DIR, `launcher-drop-slot-${w.id}.png`), png);
    }
  }, 120_000);
});
