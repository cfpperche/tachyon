import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

/**
 * ANCHOR — owner dogfood, 2026-08-20: when the Design Mode launcher gate is off, do not show a
 * dead-end Design Mode screen. Open Settings with the Integrated Browser field visibly highlighted
 * and keyboard-focused. The destination must remain legible without horizontal overflow at 880/360.
 */
const OUT = process.env.DESIGN_MODE_SETTINGS_SHOT_DIR ?? ".tachyon/vqa/visual-qa";

describe("Design Mode gate-off opens the exact Settings field", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), args: ["--no-sandbox"] });
    page = await browser.newPage();
  });

  afterAll(async () => { await browser?.close(); await server?.close(); });

  for (const width of [880, 360]) {
    it(`focuses and highlights Integrated Browser without overflow at ${width}`, async () => {
      await page.setViewport({ width, height: 900 });
      const surface = await openPreview(page, server.origin, {
        query: { view: "settings", fixture: "ide-browser-focus" },
        width,
        height: 900,
        waitFor: ".ck-settings-highlight",
      });
      const state = await surface.evaluate(() => {
        const block = document.querySelector<HTMLElement>('[data-testid="control-settings-ide-browser"]');
        return {
          active: (document.activeElement as HTMLElement | null)?.dataset.testid,
          highlighted: block?.classList.contains("ck-settings-highlight") ?? false,
          top: block?.getBoundingClientRect().top ?? -1,
          bottom: block?.getBoundingClientRect().bottom ?? -1,
          viewport: window.innerHeight,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      expect(state.active).toBe("ide-browser-enabled-toggle");
      expect(state.highlighted).toBe(true);
      expect(state.top).toBeGreaterThanOrEqual(0);
      expect(state.bottom).toBeLessThanOrEqual(state.viewport);
      expect(state.overflow).toBe(false);
      await page.screenshot({ path: `${OUT}/design-mode-settings-focus-${width}.png`, fullPage: true });
    });
  }
});
