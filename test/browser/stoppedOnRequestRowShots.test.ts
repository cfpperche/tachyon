import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, type FleetVM, type TabId } from "@tachyon/shared/sidebar/types.js";

/**
 * t-9d76b1 — headless Visual QA for the row of an agent the HUMAN stopped.
 *
 * THE ANCHOR, written from the task's problem statement before this screen existed, and not from what
 * the screen ended up looking like:
 *
 *   A person who stopped an agent must see, in the row, that a stop is what happened — a quiet
 *   finished state, not an alarm — and must still find the way back in. The row carries ONE state
 *   marker and it is not the crash marker; it says "stopped" and keeps the runtime's own exit code
 *   when that code is non-zero; nothing failure-toned sits beside `resumable`. It stays tellable
 *   apart from the crashed row above it at 880 and at 360.
 *
 * The defect arrived as a screenshot — `exited (130)` in crash red with `resumable` beside it — so the
 * proof is measured in a browser at both widths. The COLOURS and the geometry are asserted, not
 * eyeballed: "not the crash marker" is a measurement (the two dots must not resolve to the same paint),
 * and a shot alone cannot fail.
 *
 * Not part of `verify:full` (needs system Chrome + a built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/stoppedOnRequestRowShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-9d76b1-stopped-on-request");
const DIST = path.resolve(__dirname, "../../dist/webview");
const shotPage = path.join(DIST, "stopped-on-request-shot.html");

/** The repo's pair. 880 is a wide sidebar; 360 is a person dragging it in. */
const WIDTHS = [
  { id: "880", px: 880 },
  { id: "360", px: 360 },
];

/** The two rows a person has to be able to tell apart, from the shipped SAMPLE. */
const STOPPED_ON_REQUEST = "grok-builder";
const CRASHED = "migration";

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
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-9d76b1 a stop the human asked for — headless Visual QA", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: { fleets?: FleetVM[]; initialTab?: TabId; selectedWsHash?: string }) => unknown;

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

  async function shoot(width: { id: string; px: number }): Promise<void> {
    await page.setViewport({ width: width.px, height: 900, deviceScaleFactor: 1 });
    // Served FROM dist/webview (not setContent) so codicon.css's relative font url resolves.
    writeFileSync(shotPage, pageHtml(renderStatic(App({ fleets: [fleet], initialTab: "Agents", selectedWsHash: "ws" }))));
    await page.goto(`file://${shotPage}`, { waitUntil: "load" });
    await page.screenshot({ path: path.join(OUT_DIR, `agents-${width.id}.png`) });
  }

  /** What the two rows actually PAINT, read off the rendered document. */
  const rows = (stopped: string, crashed: string) => page.evaluate(([stoppedName, crashedName]) => {
    const read = (name: string) => {
      const row = document.querySelector<HTMLElement>(`[data-name="${name}"]`);
      if (!row) return null;
      const dot = row.querySelector<HTMLElement>(".sdot");
      const dotStyle = dot ? getComputedStyle(dot) : undefined;
      const sub = row.querySelector<HTMLElement>(".msub");
      const rect = (el: Element | null | undefined) =>
        el ? (el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; right: number; bottom: number }) : null;
      return {
        dotClass: dot?.className ?? "",
        // border included: the stopped dot is a transparent disc with a ring, the crashed one is filled.
        dotPaint: dotStyle ? `${dotStyle.backgroundColor}|${dotStyle.borderColor}|${dotStyle.borderWidth}` : "",
        dots: row.querySelectorAll(".sdot").length,
        sub: sub?.textContent ?? "",
        subRect: rect(sub),
        rowRect: rect(row),
        // Anything the design system paints as a failure inside this row.
        errorToned: [...row.querySelectorAll<HTMLElement>("*")]
          .filter((el) => /\b(err|error|danger|fail)\b/.test(el.className.toString()))
          .map((el) => el.className.toString()),
        text: (row.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    };
    return {
      stopped: read(stoppedName),
      crashed: read(crashedName),
      docWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  }, [stopped, crashed] as const);

  it("reads as a finished stop, keeps the runtime's exit code, and is not the crash row", async () => {
    for (const w of WIDTHS) {
      await shoot(w);
      const g = await rows(STOPPED_ON_REQUEST, CRASHED);

      expect(g.stopped, `@ ${w.id}: the stopped-on-request row must be on screen`).not.toBeNull();
      expect(g.crashed, `@ ${w.id}: the crashed row must be on screen to compare against`).not.toBeNull();

      // ONE state marker, and it is the quiet one. `crashed` would be the filled error disc.
      expect(g.stopped!.dots, `@ ${w.id}: one state marker per row`).toBe(1);
      expect(g.stopped!.dotClass, `@ ${w.id}: state marker class`).toContain("stopped");
      expect(g.stopped!.dotClass, `@ ${w.id}: a stop must not paint the crash marker`).not.toContain("crashed");
      // …measured, not assumed from the class name: the two must not resolve to the same paint.
      expect(g.stopped!.dotPaint, `@ ${w.id}: the stop and the crash paint identically`).not.toBe(g.crashed!.dotPaint);

      // It says what happened AND what the runtime answered with — never a fabricated `exited (0)`.
      expect(g.stopped!.sub, `@ ${w.id}: subline`).toBe("stopped (exit 130)");
      expect(g.stopped!.text, `@ ${w.id}: a stop must not be dressed as an exit failure`).not.toContain("exited (130)");
      // The crashed row keeps its own honest wording.
      expect(g.crashed!.sub, `@ ${w.id}: the crashed row's subline`).toBe("exited (1)");

      // Nothing in the row contradicts the other half of it: `resumable` beside a failure tone was the
      // pair of badges the owner saw.
      expect(g.stopped!.errorToned, `@ ${w.id}: failure-toned element inside a stopped row`).toEqual([]);

      // Readable at this width: the subline is inside its own row's box, not clipped out of the frame.
      expect(g.stopped!.subRect!.width, `@ ${w.id}: subline has room to read`).toBeGreaterThan(20);
      expect(g.stopped!.subRect!.right, `@ ${w.id}: subline pushed out of the sidebar`).toBeLessThanOrEqual(w.px);
      expect(g.docWidth, `@ ${w.id}: horizontal overflow`).toBeLessThanOrEqual(g.viewportWidth);
    }
  }, 120_000);
});
