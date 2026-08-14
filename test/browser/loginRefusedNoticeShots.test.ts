import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, type FleetVM, type NoticeVM } from "@tachyon/shared/sidebar/types.js";

/**
 * t-2656d7 (SDD 495 first slice) — headless Visual QA for the notice that replaces the status bar.
 *
 * **Anchor, written from the problem statement before the slice was built:** a human who pressed ▶
 * on an unauthenticated agent can read, without hovering, scrolling or waiting, WHICH RUNTIME is
 * unauthenticated, WHICH AGENT it blocked, and WHAT TO PRESS next — and the thing to press is
 * visible as a control, not as the tail of a sentence.
 *
 * That last clause is the design, and it is a direct answer to the incident: every surface that
 * renders this row bounds its text somewhere, so the recovery cannot live only in the words. A
 * clipped sentence beside a button labelled `Log in` still transmits the fix; a clipped sentence
 * alone is what the owner got.
 *
 * Two widths because one hides the class of defect worth catching (a row whose per-item controls
 * collapse when there is no room). 880 and 360 are this repository's pair.
 *
 * Not part of `verify:full` (needs system Chrome + built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/loginRefusedNoticeShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-2656d7-login-refused-notice");
const DIST = EXTENSION_WEBVIEW_DIST;

const WIDTHS = [{ id: "880", px: 880 }, { id: "360", px: 360 }];

/** The message this slice actually emits, verbatim from `describeAuthRequired`. */
function refusal(agent: string, runtime: string, action: string, actions: NoticeVM["actions"], index: number): NoticeVM {
  return {
    id: `login-refused-${index}`,
    message: `agent '${agent}' cannot run: the ${runtime} runtime reports it is not authenticated`
      + ` — ${action}. Tachyon will not retry or restart it automatically.`,
    level: "warn",
    at: new Date(Date.UTC(2026, 7, 7, 22, 41 + index)).toISOString(),
    collapsedCount: 1,
    actions,
    read: false,
    actionsLive: true,
  };
}

const refusedFleet: FleetVM = {
  ...SAMPLE,
  folder: { hash: "ws", name: "Project" },
  notices: [
    // The owner's own case: a runtime WITH a measured login command.
    refusal("grok-builder", "grok", "run `grok login --device-code`, or set XAI_API_KEY, then restart the agent explicitly", [
      { id: "a-login", label: "Log in" },
      { id: "a-retry", label: "Retry" },
    ], 0),
    // A runtime WITHOUT one. It must lose the button and keep everything else — the absence is a
    // declaration, not a degraded row.
    refusal("pi-scout", "pi", "run /login in Pi, or set the provider API-key environment variable, then restart the agent explicitly", [
      { id: "b-retry", label: "Retry" },
    ], 1),
  ],
};

/**
 * The NEIGHBOUR this change must not regress: the mid-run auth hold renders through the same notice
 * path with a single `Open`, and its geometry has to be unchanged beside the new rows.
 */
const neighbourFleet: FleetVM = {
  ...SAMPLE,
  folder: { hash: "ws", name: "Project" },
  notices: [
    refusal("claude-held", "claude", "run /login in the Claude runtime, then restart the agent explicitly", [
      { id: "n-open", label: "Open" },
    ], 0),
  ],
};

function pageHtml(body: string): string {
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${codicon}${ds}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-2656d7 login-refusal notice headless Visual QA", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: { fleets?: FleetVM[]; initialTab?: string }) => unknown;

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

  afterAll(async () => { await browser?.close(); });

  async function shoot(name: string, html: string, width: number): Promise<void> {
    await page.setViewport({ width, height: 720, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(html), { waitUntil: "domcontentloaded" });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `${name} must not scroll horizontally at ${width}px`)
      .toBeLessThanOrEqual(overflow.clientWidth + 1);
    writeFileSync(path.join(OUT_DIR, `${name}.png`), await page.screenshot({ type: "png", fullPage: false }));
  }

  it("the refusal is readable and its control is reachable at 880 and 360", async () => {
    const refusedHtml = renderStatic(App({ fleets: [refusedFleet], initialTab: "Attentions" as never }));
    const neighbourHtml = renderStatic(App({ fleets: [neighbourFleet], initialTab: "Attentions" as never }));

    for (const w of WIDTHS) {
      await shoot(`login-refused-${w.id}`, refusedHtml, w.px);
      await shoot(`neighbour-midrun-hold-${w.id}`, neighbourHtml, w.px);
    }

    // The anchor's last clause, mechanically: at BOTH widths the control is rendered, inside the
    // viewport, and big enough to press. A button that survives only at 880 fails the anchor,
    // because narrow is exactly where the sentence is clipped hardest and the button matters most.
    for (const w of WIDTHS) {
      await page.setViewport({ width: w.px, height: 720, deviceScaleFactor: 1 });
      await page.setContent(pageHtml(refusedHtml), { waitUntil: "domcontentloaded" });
      const controls = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-testid="attention-card"]')];
        return cards.map((card) => {
          const buttons = [...card.querySelectorAll("button")]
            .map((b) => ({ label: (b.textContent ?? "").trim(), rect: b.getBoundingClientRect() }))
            .filter((b) => b.label.length > 0);
          return {
            text: (card.textContent ?? "").trim(),
            buttons: buttons.map((b) => ({
              label: b.label,
              width: Math.round(b.rect.width),
              height: Math.round(b.rect.height),
              inViewport: b.rect.left >= -1 && b.rect.right <= window.innerWidth + 1,
            })),
          };
        });
      });

      expect(controls.length, `two refusals must render at ${w.px}px`).toBe(2);
      const grok = controls[0]!;
      const pi = controls[1]!;

      // WHICH runtime and WHICH agent, present in the row itself at both widths.
      expect(grok.text).toContain("grok-builder");
      expect(grok.text).toContain("grok runtime reports it is not authenticated");

      // WHAT TO PRESS, as a control.
      expect(grok.buttons.map((b) => b.label)).toEqual(expect.arrayContaining(["Log in", "Retry"]));
      // The runtime with no measured login keeps the row and loses only the button.
      expect(pi.buttons.map((b) => b.label)).toEqual(expect.arrayContaining(["Retry"]));
      expect(pi.buttons.map((b) => b.label)).not.toContain("Log in");

      for (const button of [...grok.buttons, ...pi.buttons]) {
        expect(button.inViewport, `'${button.label}' must be reachable at ${w.px}px`).toBe(true);
        expect(button.width, `'${button.label}' width at ${w.px}px`).toBeGreaterThan(24);
        expect(button.height, `'${button.label}' height at ${w.px}px`).toBeGreaterThan(12);
      }
    }
  }, 120_000);
});
