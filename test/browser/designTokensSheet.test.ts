import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";

const TOKENS_CSS = readFileSync("src/webview/shared/tokens.css", "utf8");

describe("SDD 505 Slice 1 — standalone token sheet", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head>
      <style>${TOKENS_CSS}</style>
      <style>
        :root {
          --vscode-foreground: #cccccc;
          --vscode-widget-border: #454545;
          --vscode-focusBorder: #0078d4;
        }
        #fixture {
          color: var(--ds-fg);
          border: 1px solid var(--ds-border);
          outline: 1px solid var(--ds-focus);
          opacity: var(--ds-disabled-opacity);
        }
      </style>
    </head><body><div id="fixture">tokens</div></body></html>`, { waitUntil: "load" });
  });

  afterAll(async () => { await browser?.close(); });

  it("resolves colour, border, focus, and disabled opacity without faces or components", async () => {
    const styles = await page.$eval("#fixture", (element) => {
      const computed = getComputedStyle(element);
      return {
        color: computed.color,
        border: computed.borderTopColor,
        outline: computed.outlineColor,
        opacity: computed.opacity,
      };
    });

    expect(styles).toEqual({
      color: "rgb(204, 204, 204)",
      border: "rgb(69, 69, 69)",
      outline: "rgb(0, 120, 212)",
      opacity: "0.5",
    });
  });
});
