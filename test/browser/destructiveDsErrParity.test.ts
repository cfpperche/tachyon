import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";

// t-480d59 — --destructive must compute to the same colour as .ds-badge.err, including on a
// theme that has no --vscode-errorForeground. That is the drift the source guard exists to
// prevent: today the two tokens share a vscode var by coincidence; without the --ds-err bridge
// they split the moment the primary vscode token is missing.
const TOKENS_CSS = readFileSync("packages/webview-ui/src/webview/shared/tokens.css", "utf8");
const DS_CSS = readFileSync("packages/webview-ui/src/webview/shared/design-system.css", "utf8");
const THEME_CSS = readFileSync("packages/webview-ui/src/webview/shared/vscode-theme.css", "utf8");
const EVIDENCE_DIR = path.resolve(".tachyon/vqa/visual-qa");

function fixtureHtml(rootExtras: string): string {
  return `<!doctype html><html><head>
    <style>${TOKENS_CSS}</style>
    <style>${DS_CSS}</style>
    <style>${THEME_CSS}</style>
    <style>
      :root {
        --vscode-editor-background: #1e1e1e;
        --vscode-editor-foreground: #cccccc;
        --vscode-foreground: #cccccc;
        --vscode-widget-border: #454545;
        --vscode-button-foreground: #ffffff;
        ${rootExtras}
      }
      body { margin: 0; padding: 24px; background: #1e1e1e; color: #cccccc; font-family: sans-serif; }
      .row { display: flex; gap: 16px; align-items: center; }
      #kit-destructive { color: var(--destructive); font-size: 11px; line-height: 1.6; }
    </style>
  </head><body>
    <div class="row">
      <span id="legacy-err" class="ds-badge err">error</span>
      <span id="kit-destructive">destructive</span>
    </div>
  </body></html>`;
}

async function colorsOf(page: Page) {
  return page.evaluate(() => {
    const legacy = document.getElementById("legacy-err")!;
    const kit = document.getElementById("kit-destructive")!;
    return {
      legacy: getComputedStyle(legacy).color,
      kit: getComputedStyle(kit).color,
    };
  });
}

describe("t-480d59 — --destructive tracks --ds-err / .ds-badge.err", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => { await browser?.close(); });

  it("matches .ds-badge.err when errorForeground is present", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(fixtureHtml("--vscode-errorForeground: #e51400;"), { waitUntil: "load" });
      const colors = await colorsOf(page);
      expect(colors.kit).toBe(colors.legacy);
      expect(colors.kit).toBe("rgb(229, 20, 0)");
    } finally {
      await page.close();
    }
  });

  it("still matches .ds-badge.err when errorForeground is missing (the drift case)", async () => {
    // No --vscode-errorForeground. --ds-err falls through to list-errorForeground; the old
    // --destructive chain fell through to #f14c4c and the two colours split.
    const page = await browser.newPage();
    try {
      await page.setContent(fixtureHtml("--vscode-list-errorForeground: #c05050;"), { waitUntil: "load" });
      const colors = await colorsOf(page);
      expect(colors.kit).toBe(colors.legacy);
      expect(colors.kit).toBe("rgb(192, 80, 80)");
      expect(colors.kit).not.toBe("rgb(241, 76, 76)"); // #f14c4c — the old shadcn-only fallback
    } finally {
      await page.close();
    }
  });

  it("renders the two surfaces the same colour at 880 and 360", async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const page = await browser.newPage();
    try {
      await page.setContent(fixtureHtml("--vscode-list-errorForeground: #c05050;"), { waitUntil: "load" });
      for (const width of [880, 360] as const) {
        await page.setViewport({ width, height: 200, deviceScaleFactor: 1 });
        const colors = await colorsOf(page);
        expect(colors.kit, `${width}px`).toBe(colors.legacy);
        const file = path.join(EVIDENCE_DIR, `t-480d59-destructive-ds-err-${width}.png`);
        await page.screenshot({ path: file as `${string}.png` });
      }
    } finally {
      await page.close();
    }
  });
});
