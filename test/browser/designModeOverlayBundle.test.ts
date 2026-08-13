import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";

let browser: Browser;
const bundle = fs.readFileSync(path.resolve("dist/webview/design-mode-overlay.js"), "utf8");

declare global {
  interface Window {
    __tachyonDmQueue?: string[];
    __tachyonDmCleanup?: () => void;
    __tachyonDmOverlay?: {
      mount(options: { bindingName: string; focusColor: string; restorePickMode: boolean }): { version: number };
      unmount(): boolean;
    };
  }
}

beforeAll(async () => {
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, HANG_TIMEOUT_MS);
afterAll(async () => { await browser?.close(); });

describe("Design Mode compiled IIFE", () => {
  it("installs, captures a real element, and cleans up without runtime imports", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<main style="margin:40px"><button id="pick-me" style="color:rgb(1, 2, 3)">Pick me</button></main>`);
      await page.evaluate((source) => { (0, eval)(source); }, bundle);
      const installed = await page.evaluate(() => window.__tachyonDmOverlay?.mount({ bindingName: "tachyonDesignModePick", focusColor: "#007fd4", restorePickMode: true }));
      expect(installed).toEqual({ version: 1 });

      await page.hover("#pick-me");
      const outline = await page.$eval("#tachyon-dm-root", (node) => ({ display: getComputedStyle(node).display, width: node.getBoundingClientRect().width }));
      expect(outline.display).toBe("block");
      expect(outline.width).toBeGreaterThan(0);

      await page.click("#pick-me");
      const pick = await page.evaluate(() => JSON.parse(window.__tachyonDmQueue?.[0] || "null"));
      expect(pick).toMatchObject({ tag: "BUTTON", id: "pick-me", text: "Pick me", styles: { color: "rgb(1, 2, 3)" } });
      expect(pick.bounds.width).toBeGreaterThan(0);

      expect(await page.evaluate(() => window.__tachyonDmOverlay?.unmount())).toBe(true);
      expect(await page.evaluate(() => ({ root: !!document.querySelector("#tachyon-dm-root"), cleanup: typeof window.__tachyonDmCleanup, api: typeof window.__tachyonDmOverlay }))).toEqual({ root: false, cleanup: "undefined", api: "undefined" });
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);
});
