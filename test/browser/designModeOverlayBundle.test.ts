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
    tachyonDesignModePick?: (raw: string) => void;
    __tachyonDmApplyAnnotationState?: (annotations: Array<Record<string, unknown>>) => number;
    __tachyonDmApplyAgentState?: (state: { agents: string[]; active?: string }) => number;
    __tachyonDmApplySendState?: (state: { status: "idle" | "sending" | "sent" | "error"; text?: string }) => string;
  }
}

beforeAll(async () => {
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, HANG_TIMEOUT_MS);
afterAll(async () => { await browser?.close(); });

describe("Design Mode compiled IIFE", () => {
  it("creates a host-acknowledged annotation badge and deletes it", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<main style="margin:40px"><button id="pick-me" style="color:rgb(1, 2, 3)">Pick me</button></main>`);
      await page.evaluate((source) => { (0, eval)(source); }, bundle);
      await page.evaluate(() => {
        let annotations: Array<Record<string, unknown>> = [];
        window.tachyonDesignModePick = (raw) => {
          const request = JSON.parse(raw) as { __annotation?: string; capture?: Record<string, unknown>; intent?: string; comment?: string; index?: number };
          if (request.__annotation === "add" && request.capture) annotations = [...annotations, { ...request.capture, intent: request.intent, comment: request.comment, index: annotations.length + 1 }];
          if (request.__annotation === "delete") annotations = annotations.filter((item) => item.index !== request.index);
          window.__tachyonDmApplyAnnotationState?.(annotations);
        };
      });
      const installed = await page.evaluate(() => window.__tachyonDmOverlay?.mount({ bindingName: "tachyonDesignModePick", focusColor: "#007fd4", restorePickMode: true }));
      expect(installed).toEqual({ version: 2 });

      await page.hover("#pick-me");
      const outline = await page.$eval("#tachyon-dm-root", (node) => ({ display: getComputedStyle(node).display, width: node.getBoundingClientRect().width }));
      expect(outline.display).toBe("block");
      expect(outline.width).toBeGreaterThan(0);

      await page.click("#pick-me");
      await page.type('[aria-label="Annotation comment"]', "Increase the contrast");
      await page.click('[data-testid="annotation-add"]');
      await page.waitForSelector('[data-testid="annotation-badge-1"]');
      expect(await page.$eval('[data-testid="annotation-row-1"]', (node) => node.textContent)).toContain("Increase the contrast");
      const add = await page.evaluate(() => JSON.parse(window.__tachyonDmQueue?.find((raw) => JSON.parse(raw).__annotation === "add") || "null"));
      expect(add).toMatchObject({ intent: "change", comment: "Increase the contrast", capture: { target: { tag: "BUTTON", id: "pick-me", text: "Pick me", styles: { color: "rgb(1, 2, 3)" } } } });
      expect(add.capture.target.bounds.width).toBeGreaterThan(0);
      expect(add.capture.screenshot).toBeUndefined();

      await page.click('[aria-label="Delete annotation 1"]');
      await page.waitForSelector('[data-testid="annotation-tray"]', { hidden: true });
      expect(await page.$('[data-testid="annotation-badge-1"]')).toBeNull();

      expect(await page.evaluate(() => window.__tachyonDmOverlay?.unmount())).toBe(true);
      expect(await page.evaluate(() => ({ root: !!document.querySelector("#tachyon-dm-root"), cleanup: typeof window.__tachyonDmCleanup, api: typeof window.__tachyonDmOverlay }))).toEqual({ root: false, cleanup: "undefined", api: "undefined" });
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("marks an annotation whose target disappears instead of leaving an orphan badge", async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 360, height: 640 });
      await page.setContent(`<button id="ephemeral">Temporary target</button>`);
      await page.evaluate((source) => { (0, eval)(source); }, bundle);
      await page.evaluate(() => {
        window.tachyonDesignModePick = (raw) => {
          const request = JSON.parse(raw) as { __annotation?: string; capture?: Record<string, unknown>; intent?: string; comment?: string };
          if (request.__annotation === "add" && request.capture) window.__tachyonDmApplyAnnotationState?.([{ ...request.capture, intent: request.intent, comment: request.comment, index: 1 }]);
        };
        window.__tachyonDmOverlay?.mount({ bindingName: "tachyonDesignModePick", focusColor: "#007fd4", restorePickMode: true });
      });
      await page.click("#ephemeral");
      await page.type('[aria-label="Annotation comment"]', "Keep this visible");
      await page.click('[data-testid="annotation-add"]');
      await page.waitForSelector('[data-testid="annotation-badge-1"]');
      await page.$eval("#ephemeral", (node) => node.remove());
      await page.waitForFunction(() => document.querySelector('[data-testid="annotation-row-1"]')?.textContent?.includes("Target not found"));
      expect(await page.$('[data-testid="annotation-badge-1"]')).toBeNull();
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("renders the host roster inside the tray and posts one send without clearing before host confirmation", async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 880, height: 700 });
      await page.setContent(`<button id="cta">Send feedback target</button>`);
      await page.evaluate((source) => { (0, eval)(source); }, bundle);
      await page.evaluate(() => {
        window.tachyonDesignModePick = (raw) => {
          const request = JSON.parse(raw) as { __annotation?: string; action?: string; targetAgent?: string; capture?: Record<string, unknown>; intent?: string; comment?: string };
          if (request.__annotation === "add" && request.capture) window.__tachyonDmApplyAnnotationState?.([{ ...request.capture, intent: request.intent, comment: request.comment, index: 1 }]);
          if (request.__annotation === "agents") window.__tachyonDmApplyAgentState?.({ agents: ["ada", "new-agent"], active: "ada" });
        };
        window.__tachyonDmOverlay?.mount({ bindingName: "tachyonDesignModePick", focusColor: "#007fd4", restorePickMode: true });
      });
      await page.click("#cta");
      await page.type('[aria-label="Annotation comment"]', "Fix it");
      await page.click('[data-testid="annotation-add"]');
      await page.select('[data-testid="annotation-agent-select"]', "new-agent");
      await page.click('[data-testid="annotation-send"]');

      const sent = await page.evaluate(() => window.__tachyonDmQueue?.map((raw) => JSON.parse(raw)).find((item) => item.action === "annotation.send"));
      expect(sent).toEqual({ action: "annotation.send", targetAgent: "new-agent" });
      expect(await page.$('[data-testid="annotation-row-1"]')).not.toBeNull();
      await page.evaluate(() => window.__tachyonDmApplySendState?.({ status: "error", text: "Receipt not confirmed; annotations preserved." }));
      expect(await page.$eval('[role="status"]', (node) => node.textContent)).toContain("annotations preserved");
      expect(await page.$('[data-testid="annotation-row-1"]')).not.toBeNull();
      await page.evaluate(() => { window.__tachyonDmApplyAnnotationState?.([]); window.__tachyonDmApplySendState?.({ status: "sent", text: "Sent." }); });
      await page.waitForSelector('[data-testid="annotation-tray"]', { hidden: true });
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);
});
