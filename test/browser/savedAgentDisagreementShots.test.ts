import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, type FleetVM, type TabId } from "../../src/sidebar/types.js";

/**
 * SDD 494 Part 4 — headless Visual QA for the sidebar row that now carries the disagreement state.
 *
 * THE ANCHOR, written from the task's problem statement and not from the finished screen:
 *
 *   A person who sees a broken agent in the sidebar learns, from the row itself, WHICH records
 *   disagree about it — without the row growing, wrapping, or pushing anything out of the sidebar at
 *   any width a person can drag it to. The healthy row beside it looks exactly as it did before.
 *
 * `plan.md` predicted a length risk: the measured refusal is already around 260 characters and the
 * state name makes it longer. The prediction is answered by measurement here rather than by reading
 * the source — the refusal rides a `title` tooltip (`src/webview/sidebar/App.tsx`, the `refused` meta
 * renderer), so the assertion is that row GEOMETRY does not move, and that the state is nevertheless
 * present in the attribute a person hovers.
 *
 * Not part of `verify:full` (needs system Chrome + a built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/savedAgentDisagreementShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-6c029b-saved-agent-disagreement");
const DIST = path.resolve(__dirname, "../../dist/webview");
const shotPage = path.join(DIST, "saved-agent-disagreement-shot.html");

/** The repo's pair. 880 is a wide sidebar; 360 is a person dragging it in. */
const WIDTHS = [
  { id: "880", px: 880 },
  { id: "360", px: 360 },
];

const UNPROJECTABLE = "unprojectable — the profile and the runtime configuration disagree. profile: "
  + "profile/native-config-value: Claude global key 'permissions.defaultMode' value 'bypassPermissions' is "
  + "not projectable (supported: acceptEdits, auto, manual, dontAsk, plan); authorize it explicitly for this "
  + "agent, set the Permissions family to Exclude, or change the global value";
/** The string as it read BEFORE this change: the same refusal with no state on the front. */
const BEFORE = UNPROJECTABLE.slice(UNPROJECTABLE.indexOf("profile: "));

const base = {
  ...SAMPLE,
  folder: { hash: "hash-alpha", name: "tachyon" },
  terminals: [], pipelines: [], schedules: [], commands: [], runbooks: [], pins: [], notices: [],
};

/** The neighbour the change must not regress, plus the three states that keep a roster row. */
const fleetWith = (refused: string): FleetVM => ({
  ...base,
  agents: [
    { name: "claude", status: "idle", kind: "agent" },
    { name: "claude23", status: "stopped", kind: "agent", refused },
    { name: "deleted-by-hand", status: "stopped", kind: "agent", refused: "orphan-locator — the roster and the profile on disk disagree. profile: canonical profile is missing" },
    { name: "copied-roster", status: "stopped", kind: "agent", refused: "unattested — the roster and the host authority disagree. profile: host profile authority is missing" },
  ],
} as FleetVM);

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
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("SDD 494 Part 4 saved-agent disagreement on the sidebar row — headless Visual QA", () => {
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

  async function render(fleet: FleetVM, width: { id: string; px: number }, shot?: string) {
    await page.setViewport({ width: width.px, height: 760, deviceScaleFactor: 1 });
    writeFileSync(shotPage, pageHtml(renderStatic(App({ fleets: [fleet], initialTab: "Agents", selectedWsHash: "hash-alpha" }))));
    await page.goto(`file://${shotPage}`, { waitUntil: "load" });
    if (shot) await page.screenshot({ path: path.join(OUT_DIR, `${shot}-${width.id}.png`) });
  }

  const geometry = () => page.evaluate(() => {
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect().toJSON() as { width: number; height: number; right: number } : null);
    const row = (name: string) => document.querySelector(`[data-name="${name}"]`);
    const badgeOf = (name: string) => [...(row(name)?.querySelectorAll("[title]") ?? [])]
      .find((el) => el.textContent?.trim() === "refused") ?? null;
    return {
      healthy: rect(row("claude")),
      refusedRow: rect(row("claude23")),
      badgeText: badgeOf("claude23")?.textContent?.trim() ?? null,
      badgeTitle: badgeOf("claude23")?.getAttribute("title") ?? null,
      badgeWidth: rect(badgeOf("claude23"))?.width ?? null,
      rowNames: [...document.querySelectorAll("[data-name]")].map((e) => e.getAttribute("data-name")),
      docWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

  for (const width of WIDTHS) {
    it(`@ ${width.id}: the state reaches the reader and the row does not move`, async () => {
      await render(fleetWith(BEFORE), width);
      const before = await geometry();
      await render(fleetWith(UNPROJECTABLE), width, "disagreement");
      const after = await geometry();

      // Every row is still there. A refused agent that vanishes is the failure t-0ad300 fixed.
      expect(after.rowNames, `@ ${width.id}: rows`).toEqual(before.rowNames);

      // The state reached the reader, in the attribute a person hovers.
      expect(after.badgeTitle, `@ ${width.id}: the state must be on the row`).toContain("unprojectable — the profile and the runtime configuration disagree.");
      expect(after.badgeTitle, `@ ${width.id}: the runtime's own reason must survive`).toContain("'bypassPermissions' is not projectable");

      // …and NOTHING about the laid-out row moved. This is the length risk `plan.md` predicted,
      // answered: the badge reads "refused" either way, so the longer string has no geometry.
      expect(after.badgeText, `@ ${width.id}: badge label`).toBe("refused");
      expect(after.badgeWidth, `@ ${width.id}: badge width moved`).toBe(before.badgeWidth);
      expect(after.refusedRow!.height, `@ ${width.id}: the refused row grew`).toBe(before.refusedRow!.height);
      expect(after.healthy!.height, `@ ${width.id}: the healthy NEIGHBOUR regressed`).toBe(before.healthy!.height);
      // Measured, and NOT asserted as equal to the neighbour: a refused row is taller than a healthy
      // one (58 vs 34 at both widths) because it carries an extra badge. That predates this change —
      // both numbers are identical before and after — so it is recorded here rather than fixed here.
      expect(after.refusedRow!.height, `@ ${width.id}: a refused row should still be the taller one`).toBeGreaterThan(after.healthy!.height);

      // Nothing scrolls sideways at any width a person can drag to.
      expect(after.docWidth, `@ ${width.id}: horizontal overflow`).toBeLessThanOrEqual(after.viewportWidth);
      expect(after.refusedRow!.right, `@ ${width.id}: the row is pushed out of the sidebar`).toBeLessThanOrEqual(width.px);
    }, 60_000);
  }
});
