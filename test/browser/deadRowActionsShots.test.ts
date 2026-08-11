import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, type FleetVM, type TabId } from "../../src/sidebar/types.js";

/**
 * t-c515c0 — headless Visual QA for the ACTION BAR of a row whose process is gone.
 *
 * THE ANCHOR, written from the task's problem statement before the fix existed, and not from what the
 * screen ended up looking like:
 *
 *   A person looking at a row whose agent is GONE must not be offered the repertoire of a live one.
 *   The row for a stop the human asked for offers no way to open a terminal or a pane — there is no
 *   process behind it, and the pane it would open holds nothing. The crashed row is NOT the same row:
 *   its pane still holds the last screen it painted, so it keeps those doors. A stop and a crash must
 *   therefore stay tellable apart by what they OFFER, not only by what they say, at 880 and at 360.
 *
 * Why the crash keeps what the stop loses is measured, not assumed (`t-c515c0` journal): a graceful
 * stop lets the TUI restore the primary screen, so the postmortem pane retains ONE line — tmux's own
 * `Pane is dead (status …)` — on claude, codex, grok and pi alike. A process that dies without
 * restoring keeps its alternate screen, and the same measurement read 20 non-blank lines back.
 *
 * The defect arrived as a screenshot (an eye and a terminal beside `stopped (exit 130)`), so the proof
 * is read off the rendered document at both widths rather than eyeballed: the inline bar is asserted as
 * an exact SET of labels, which is what makes a renamed or re-added door fail here.
 *
 * Not part of `verify:full` (needs system Chrome + a built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/deadRowActionsShots.test.ts
 * Set TACHYON_SHOT_PHASE=before to capture the pre-fix shots into the `before/` folder.
 */
const PHASE = process.env.TACHYON_SHOT_PHASE === "before" ? "before" : "after";
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-c515c0-dead-row-actions", PHASE);
const DIST = path.resolve(__dirname, "../../dist/webview");
const shotPage = path.join(DIST, "dead-row-actions-shot.html");

/** The repo's pair. 880 is a wide sidebar; 360 is a person dragging it in. */
const WIDTHS = [
  { id: "880", px: 880 },
  { id: "360", px: 360 },
];

/** From the shipped SAMPLE: the stop the human asked for, the crash, and a live row to contrast. */
const STOPPED_ON_REQUEST = "grok-builder";
const CRASHED = "migration";
const RUNNING = "orchestrator";

const fleet: FleetVM = { ...SAMPLE, folder: { hash: "ws", name: "Project" } };

function pageHtml(body: string): string {
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  const theme = readFileSync(path.resolve(__dirname, "../../scripts/webview-preview/theme-dark.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${codicon}${ds}${theme}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
/* The bar is hover-revealed (.actions{opacity:0} → .row:hover). The owner's screenshots ARE the hover
   state, and a shot of the idle row would show none of what this task is about, so hold every row's
   bar open. This paints what a person sees pointing at each row in turn — it changes no geometry. */
.actions{opacity:1 !important;pointer-events:auto !important}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-c515c0 the action bar of a row whose process is gone — headless Visual QA", () => {
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

  async function shoot(width: { id: string; px: number }): Promise<void> {
    await page.setViewport({ width: width.px, height: 900, deviceScaleFactor: 1 });
    // Served FROM dist/webview (not setContent) so codicon.css's relative font url resolves.
    writeFileSync(shotPage, pageHtml(renderStatic(App({ fleets: [fleet], initialTab: "Agents", selectedWsHash: "ws" }))));
    await page.goto(`file://${shotPage}`, { waitUntil: "load" });
    await page.screenshot({ path: path.join(OUT_DIR, `agents-${width.id}.png`) });
  }

  /** The inline action bar each row actually PAINTS, read off the rendered document. */
  const bars = (names: readonly string[]) => page.evaluate((rowNames) => {
    const read = (name: string) => {
      const row = document.querySelector<HTMLElement>(`[data-name="${name}"]`);
      if (!row) return null;
      const buttons = [...row.querySelectorAll<HTMLElement>("button.act")].map(
        (b) => b.getAttribute("aria-label") ?? "",
      );
      return {
        // The overflow trigger is not an action; the actions are what sits beside it.
        actions: buttons.filter((label) => label !== "More actions"),
        hasMore: buttons.includes("More actions"),
        rowRight: row.getBoundingClientRect().right,
      };
    };
    return {
      rows: Object.fromEntries(rowNames.map((n) => [n, read(n)])),
      docWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  }, names);

  it("a gone process offers no terminal and no pane; a crash keeps the pane it can still show", async () => {
    // Shoot BOTH widths before asserting anything: the screenshots are the evidence this run exists to
    // produce, and a red assertion at the first width must not be what destroys the second one's shot.
    const measured: { w: (typeof WIDTHS)[number]; g: Awaited<ReturnType<typeof bars>> }[] = [];
    for (const w of WIDTHS) {
      await shoot(w);
      measured.push({ w, g: await bars([STOPPED_ON_REQUEST, CRASHED, RUNNING]) });
    }

    for (const { w, g } of measured) {
      const stopped = g.rows[STOPPED_ON_REQUEST];
      const crashed = g.rows[CRASHED];
      const running = g.rows[RUNNING];
      expect(stopped, `@ ${w.id}: the stopped-on-request row must be on screen`).not.toBeNull();
      expect(crashed, `@ ${w.id}: the crashed row must be on screen to compare against`).not.toBeNull();
      expect(running, `@ ${w.id}: a live row must be on screen to compare against`).not.toBeNull();

      // THE SET, not a containment check: a door that comes back under a new label fails here.
      expect(stopped!.actions, `@ ${w.id}: inline bar of a stop the human asked for`).toEqual(["Activity"]);
      // …and it is reachable: everything else it still offers lives one deliberate click away.
      expect(stopped!.hasMore, `@ ${w.id}: the stopped row keeps its overflow menu`).toBe(true);

      // The crash is a DIFFERENT row: its pane still holds the screen it died on.
      expect(crashed!.actions, `@ ${w.id}: inline bar of a crash`).toEqual([
        "Activity",
        "Open terminal",
        "Open agent pane",
      ]);
      expect(running!.actions, `@ ${w.id}: inline bar of a live agent`).toEqual([
        "Activity",
        "Open terminal",
        "Open agent pane",
      ]);

      // The whole point of the task: these two must not read as the same row.
      expect(stopped!.actions, `@ ${w.id}: a requested stop still offers a crash's repertoire`).not.toEqual(
        crashed!.actions,
      );

      // Readable at this width: nothing pushed out of the sidebar.
      expect(stopped!.rowRight, `@ ${w.id}: row pushed out of the sidebar`).toBeLessThanOrEqual(w.px);
      expect(g.docWidth, `@ ${w.id}: horizontal overflow`).toBeLessThanOrEqual(g.viewportWidth);
    }
  }, 120_000);
});
