import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, type FleetVM, type TabId } from "../../src/sidebar/types.js";
// t-5f2b5b — the tile count below is DERIVED from the launcher catalog rather than written out. It was
// the literal `12` and went red when the Fleet tile was deleted, which is a stale number reporting a
// deliberate change as a defect. The claim this test owns is "Control keeps its launcher", not how many
// tiles the launcher happens to hold; `controlSectionNav.test.ts` is what pins the inventory itself.
import { CONTROL_SECTION_NAV } from "../../src/cockpit/sectionNav.js";

/**
 * t-72ff5a — headless Visual QA for the sidebar's single workspace regime.
 *
 * THE ANCHOR, written from the task's problem statement before the screen existed, and not from what
 * the screen ended up looking like:
 *
 *   A person opens the sidebar and can tell, without leaving the tab they are on, WHICH project
 *   everything below belongs to and how to change it. Every tab but Attentions and Control shows
 *   exactly that one project's rows — no folder header, nothing from a second project stacked under
 *   it, and no control that appears only once a second project happens to be attached. That
 *   project's handoff is reachable from every tab. At a narrow width the project name and the
 *   handoff pill still share one row, neither pushed out of it nor clipped to a stub.
 *
 * The defect and the request both arrived as screenshots, so the proof is measured in a browser at
 * both widths and both root counts. GEOMETRY is asserted, not eyeballed: "shares one row without
 * being pushed out" is a measurement, and a shot alone cannot fail.
 *
 * Not part of `verify:full` (needs system Chrome + a built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/sidebarWorkspaceScopeShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-72ff5a-sidebar-workspace-scope");
const DIST = path.resolve(__dirname, "../../dist/webview");
const shotPage = path.join(DIST, "sidebar-ws-scope-shot.html");

/** The repo's pair. 880 is a wide sidebar; 360 is a person dragging it in. */
const WIDTHS = [
  { id: "880", px: 880 },
  { id: "360", px: 360 },
];

const alpha: FleetVM = {
  ...SAMPLE,
  folder: { hash: "hash-alpha", name: "tachyon" },
  handoff: { exists: true, staleness: "needs_distill", pendingCount: 3 },
  notices: [{ id: "n-a", level: "warn", message: "[builder] needs input on the migration", at: "2026-08-05T10:00:00.000Z", collapsedCount: 1, read: false, actions: [], actionsLive: false }],
};
/** A second attached project, with rows named so a leak into Alpha's list is unmistakable. */
const beta: FleetVM = {
  ...SAMPLE,
  folder: { hash: "hash-beta", name: "a-second-project-with-a-long-name" },
  handoff: { exists: true, staleness: "old", pendingCount: 0 },
  agents: [{ name: "BETA-LEAKED-ROW", status: "running", kind: "agent" }],
  terminals: [], pipelines: [], schedules: [], commands: [], runbooks: [], pins: [],
  // the case the owner named: an agent stuck in the project the sidebar is NOT showing
  notices: [{ id: "n-b", level: "error", message: "[deployer] blocked, waiting on a human", at: "2026-08-05T11:00:00.000Z", collapsedCount: 1, read: false, actions: [], actionsLive: false }],
};

function pageHtml(body: string): string {
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  // The preview harness's own dark --vscode-* palette: without it the shot loses every token the
  // chrome is painted with and judges a screen nobody has.
  const theme = readFileSync(path.resolve(__dirname, "../../scripts/webview-preview/theme-dark.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${codicon}${ds}${theme}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-72ff5a sidebar workspace scope — headless Visual QA", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: { fleets?: FleetVM[]; initialTab?: TabId; selectedWsHash?: string }) => unknown;

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

  /** t-b24282 — the width goes to the VIEWPORT, so the surface measures its own frame, not a div. */
  async function shoot(name: string, props: Parameters<typeof App>[0], width: { id: string; px: number }) {
    await page.setViewport({ width: width.px, height: 760, deviceScaleFactor: 1 });
    // Served FROM dist/webview (not setContent) so codicon.css's relative font url resolves.
    writeFileSync(shotPage, pageHtml(renderStatic(App(props))));
    await page.goto(`file://${shotPage}`, { waitUntil: "load" });
    await applySelectValues(props.selectedWsHash);
    await page.screenshot({ path: path.join(OUT_DIR, `${name}-${width.id}.png`) });
  }

  /**
   * A HARNESS correction, and it was caught by looking at a shot rather than at an assertion.
   *
   * `<select value="…">` is not HTML: the attribute does nothing and the browser shows the FIRST
   * option. Preact assigns `dom.value` as a property when it diffs, so the live webview shows the
   * selected project — but this suite serializes to a static string and loads it as a file, with no
   * Preact on the page, so the first shot of "Beta selected" painted the name "tachyon" over Beta's
   * rows and Beta's handoff. That is the exact claim under test reading backwards, from a defect in
   * the measuring instrument.
   *
   * So the property is applied here, the way the runtime applies it, and the result is asserted
   * rather than assumed: the option must exist and the control must end up displaying that
   * project's name. A harness that silently "fixed" the picture would be worse than the artifact.
   */
  async function applySelectValues(selectedWsHash?: string): Promise<void> {
    if (!selectedWsHash) return;
    const shown = await page.evaluate((hash) => {
      const select = document.querySelector<HTMLSelectElement>(".ws-chrome .ws-select");
      if (!select) return null;
      const offered = [...select.options].map((o) => o.value);
      select.value = hash;
      return { offered, label: select.selectedOptions[0]?.textContent ?? "" };
    }, selectedWsHash);
    expect(shown, "the chrome must carry the selector").not.toBeNull();
    expect(shown!.offered, "the selection must be an option the control offers").toContain(selectedWsHash);
    expect(shown!.label.length, "the control must display the selected project's name").toBeGreaterThan(0);
  }

  const geometry = () => page.evaluate(() => {
    const chrome = document.querySelector(".ws-chrome");
    const select = document.querySelector(".ws-chrome .ws-select");
    const handoff = document.querySelector(".ws-chrome .handoff-btn");
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number; right: number; bottom: number } : null);
    return {
      chrome: rect(chrome),
      select: rect(select),
      handoff: rect(handoff),
      handoffText: handoff?.textContent ?? "",
      folderHeaders: document.querySelectorAll(".grp.folder").length,
      rowNames: [...document.querySelectorAll("[data-name]")].map((e) => e.getAttribute("data-name")),
      docWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

  for (const roots of [
    { id: "single-root", fleets: [alpha] },
    { id: "multi-root", fleets: [alpha, beta] },
  ]) {
    it(`${roots.id}: Agents shows one project, no folder header, handoff in the chrome`, async () => {
      for (const w of WIDTHS) {
        await shoot(`agents-${roots.id}`, { fleets: roots.fleets, initialTab: "Agents", selectedWsHash: "hash-alpha" }, w);
        const g = await geometry();

        // The request: one project's rows, and no aggregator above them.
        expect(g.folderHeaders, `${roots.id} @ ${w.id}: folder header`).toBe(0);
        expect(g.rowNames.join(" "), `${roots.id} @ ${w.id}: the other project leaked in`).not.toContain("beta-leaked-row");

        // The chrome answers "which project", from this tab, at this width.
        expect(g.chrome, `${roots.id} @ ${w.id}: chrome`).not.toBeNull();
        expect(g.select!.width, `${roots.id} @ ${w.id}: selector has room to read`).toBeGreaterThan(60);

        // One row, not two: the handoff pill sits beside the name rather than wrapping under it.
        expect(Math.abs(g.select!.y - g.handoff!.y), `${roots.id} @ ${w.id}: handoff wrapped to its own line`).toBeLessThan(4);
        // …and inside the frame, which is the failure a single wide shot hides.
        expect(g.handoff!.right, `${roots.id} @ ${w.id}: handoff pushed out of the sidebar`).toBeLessThanOrEqual(w.px);
        // The pill still says what it means — a stub would be worse than no pill.
        expect(g.handoffText, `${roots.id} @ ${w.id}: handoff label`).toContain("handoff");

        // Nothing scrolls sideways at any width a person can drag to.
        expect(g.docWidth, `${roots.id} @ ${w.id}: horizontal overflow`).toBeLessThanOrEqual(g.viewportWidth);
      }
    }, 60_000);
  }

  it("multi-root: switching the selector moves every scoped tab, and the two look identical to single-root", async () => {
    for (const w of WIDTHS) {
      await shoot("agents-multi-root-selected-beta", { fleets: [alpha, beta], initialTab: "Agents", selectedWsHash: "hash-beta" }, w);
      const g = await geometry();
      expect(g.folderHeaders, `@ ${w.id}`).toBe(0);
      // now the OTHER project's row is the one on screen, and Alpha's are gone
      expect(g.rowNames.join(" "), `@ ${w.id}`).toContain("beta-leaked-row");
      expect(g.rowNames.join(" "), `@ ${w.id}`).not.toContain("orchestrator");
      // …and the chrome NAMES the project whose rows are on screen — the guard's "say out loud
      // which project you are showing", checked against the panel rather than against itself.
      const shownName = await page.evaluate(() => document.querySelector<HTMLSelectElement>(".ws-chrome .ws-select")?.selectedOptions[0]?.textContent ?? "");
      expect(shownName, `@ ${w.id}`).toBe("a-second-project-with-a-long-name");
      // a long project name ellipsizes inside its own control instead of pushing the pill out
      expect(g.handoff!.right, `@ ${w.id}: long name pushed the pill out`).toBeLessThanOrEqual(w.px);
      expect(g.docWidth, `@ ${w.id}`).toBeLessThanOrEqual(g.viewportWidth);
    }
  }, 60_000);

  it("Control keeps its launcher and no longer carries the selector; Attentions stays cross-project", async () => {
    for (const w of WIDTHS) {
      await shoot("control-multi-root", { fleets: [alpha, beta], initialTab: "Control", selectedWsHash: "hash-alpha" }, w);
      const control = await page.evaluate(() => ({
        tiles: document.querySelectorAll(".ctl-tile").length,
        selectorsInSecRow: document.querySelectorAll(".sec select").length,
        chrome: document.querySelectorAll(".ws-chrome .ws-select").length,
      }));
      expect(control.tiles, `@ ${w.id}`).toBe(CONTROL_SECTION_NAV.length);
      expect(control.selectorsInSecRow, `@ ${w.id}: the selector must not be back inside a tab`).toBe(0);
      expect(control.chrome, `@ ${w.id}: exactly one selector, in the chrome`).toBe(1);

      await shoot("attentions-multi-root", { fleets: [alpha, beta], initialTab: "Attentions", selectedWsHash: "hash-alpha" }, w);
      const folders = await page.evaluate(() => [...document.querySelectorAll(".attention-folder")].map((e) => e.textContent));
      // every card names its own project — the tab is cross-project by decision, so a card read
      // against the chrome's selection would otherwise be attributed to the wrong one
      expect(folders.length, `@ ${w.id}`).toBe(2);
      expect(folders.every((f) => !!f && f.length > 0), `@ ${w.id}`).toBe(true);
      // the unselected project's stuck agent is STILL on screen — the property the owner asked for
      const messages = await page.evaluate(() => [...document.querySelectorAll(".attention-message")].map((e) => e.textContent).join(" | "));
      expect(messages, `@ ${w.id}`).toContain("blocked, waiting on a human");
    }
  }, 60_000);
});
