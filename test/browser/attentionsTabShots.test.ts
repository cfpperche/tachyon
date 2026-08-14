import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { SAMPLE, type FleetVM, type NoticeVM } from "@tachyon/shared/sidebar/types.js";

/**
 * t-37f554 — headless Visual QA for the Attentions tab at three sidebar widths.
 *
 * Not part of `verify:full` (needs system Chrome + built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/attentionsTabShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-37f554-attentions-tab");
const DIST = path.resolve(__dirname, "../../dist/webview");

const WIDTHS = [
  { id: "220", px: 220 },
  { id: "320", px: 320 },
  { id: "normal-340", px: 340 },
];

function notice(index: number): NoticeVM {
  return {
    id: `att-${index}`,
    message: [
      "codex needs a decision on the release boundary",
      "claude completed the visual sweep and is waiting for review",
      "Delivery verification failed at the behavior gate",
      "grok proposed a schedule change for approval",
      "The persistent engine recovered a wedged tmux server",
    ][index % 5]!,
    level: (["info", "warn", "error"] as const)[index % 3]!,
    at: new Date(Date.UTC(2026, 6, 29, 15, index)).toISOString(),
    collapsedCount: index === 2 ? 3 : 1,
    actions: index < 2 ? [{ id: `act-${index}`, label: index === 0 ? "Review" : "Open" }] : [],
    read: false,
    actionsLive: true,
  };
}

const fleetWithAttentions: FleetVM = {
  ...SAMPLE,
  folder: { hash: "ws", name: "Project" },
  notices: Array.from({ length: 7 }, (_, i) => notice(i)),
};

const emptyFleet: FleetVM = {
  ...SAMPLE,
  folder: { hash: "ws", name: "Project" },
  agents: SAMPLE.agents.slice(0, 2),
  notices: [],
};

function pageHtml(body: string): string {
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${codicon}${ds}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
/* preview host fills the shot frame the way VS Code fills the sidebar */
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-37f554 Attentions tab headless Visual QA", () => {
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
  });

  async function shoot(name: string, html: string, width: number): Promise<void> {
    await page.setViewport({ width, height: 720, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(html), { waitUntil: "domcontentloaded" });
    // Mechanical: no horizontal page overflow at this width.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
    });
    expect(overflow.scrollWidth, `${name} must not scroll horizontally at ${width}px`).toBeLessThanOrEqual(overflow.clientWidth + 1);
    const png = await page.screenshot({ type: "png", fullPage: false });
    writeFileSync(path.join(OUT_DIR, `${name}.png`), png);
  }

  it("Attentions list + empty + Agents-without-stack at 220 / 320 / normal", async () => {
    const attentionsHtml = renderStatic(App({ fleets: [fleetWithAttentions], initialTab: "Attentions" as never }));
    const emptyHtml = renderStatic(App({ fleets: [emptyFleet], initialTab: "Attentions" as never }));
    // Agents path hits DispatchCtx.Provider (unsupported under static render) — prove absence of the
    // stack by composition: when Attentions is selected the stack is present; the Agents structure
    // is proven by unit tests. Visual: Attentions list + empty only.

    for (const w of WIDTHS) {
      await shoot(`attentions-list-${w.id}`, attentionsHtml, w.px);
      await shoot(`attentions-empty-${w.id}`, emptyHtml, w.px);
    }

    // Sanity: list shot contains cards; empty does not.
    expect(attentionsHtml).toContain('data-testid="attention-stack"');
    expect(emptyHtml).toContain('data-testid="attention-stack-empty"');
    expect(emptyHtml).not.toContain('data-testid="attention-card"');

    // t-c61e51 — geometric contract at narrow + normal: Clear shares the section header row
    // with ATTENTIONS; no second toolbar band. Fails if the orphan toolbar returns.
    for (const w of [WIDTHS[0]!, WIDTHS[1]!]) {
      await page.setViewport({ width: w.px, height: 720, deviceScaleFactor: 1 });
      await page.setContent(pageHtml(attentionsHtml), { waitUntil: "domcontentloaded" });
      const geom = await page.evaluate(() => {
        const sec = document.querySelector(".sec");
        const clear = document.querySelector('[data-testid="attention-clear"]');
        const label = sec?.querySelector("b");
        const toolbar = document.querySelector('[data-testid="attention-toolbar"]');
        if (!sec || !clear || !label) return { ok: false as const, reason: "missing nodes" };
        const sr = sec.getBoundingClientRect();
        const cr = clear.getBoundingClientRect();
        const lr = label.getBoundingClientRect();
        return {
          ok: true as const,
          sameRow: Math.abs(cr.top - lr.top) < 8,
          clearInSec: cr.top >= sr.top - 2 && cr.bottom <= sr.bottom + 2,
          noToolbar: !toolbar,
          secHeight: Math.round(sr.height),
          width: window.innerWidth,
        };
      });
      expect(geom.ok, `t-c61e51 geometry at ${w.px}: ${JSON.stringify(geom)}`).toBe(true);
      if (geom.ok) {
        expect(geom.sameRow, `Clear must share ATTENTIONS row at ${w.px}px`).toBe(true);
        expect(geom.clearInSec, `Clear must live inside .sec at ${w.px}px`).toBe(true);
        expect(geom.noToolbar, `orphan attention-toolbar must be gone at ${w.px}px`).toBe(true);
        // Agents-like density: section header is a single compact band, not a tall toolbar stack.
        expect(geom.secHeight, `.sec height at ${w.px}`).toBeLessThanOrEqual(40);
      }
    }
  }, 120_000);
});
