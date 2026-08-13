import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { fallbackDsTokens, formatDmThemeCssBlock } from "../../src/webview/ide-browser-bridge/themeTokens";

let browser: Browser;
const bundle = fs.readFileSync(path.resolve("dist/webview/design-mode-overlay.js"), "utf8")
  .replace(JSON.stringify("__TACHYON_DM_THEME_CSS__"), JSON.stringify(formatDmThemeCssBlock(fallbackDsTokens(), ":host")));

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
    __tachyonDmApplyViewportState?: (state: { preset: "phone" | "tablet" | "desktop" | "reset"; status: "idle" | "setting" | "success" | "error"; text?: string }) => string;
    __tachyonDmApplyMarkupState?: (state: { frozen?: string; sourceUrl?: string; shapes: unknown[]; status?: string; text?: string }) => string;
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
      const outline = await page.$eval("pierce/#tachyon-dm-root", (node) => ({ display: getComputedStyle(node).display, width: node.getBoundingClientRect().width }));
      expect(outline.display).toBe("block");
      expect(outline.width).toBeGreaterThan(0);

      await page.click("#pick-me");
      await page.type('pierce/[aria-label="Annotation comment"]', "Increase the contrast");
      await page.click('pierce/[data-testid="annotation-add"]');
      await page.waitForFunction(() => !!document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="annotation-badge-1"]'));
      expect(await page.$eval('pierce/[data-testid="annotation-row-1"]', (node) => node.textContent)).toContain("Increase the contrast");
      const add = await page.evaluate(() => JSON.parse(window.__tachyonDmQueue?.find((raw) => JSON.parse(raw).__annotation === "add") || "null"));
      expect(add).toMatchObject({ intent: "change", comment: "Increase the contrast", capture: { target: { tag: "BUTTON", id: "pick-me", text: "Pick me", styles: { color: "rgb(1, 2, 3)" } } } });
      expect(add.capture.target.bounds.width).toBeGreaterThan(0);
      expect(add.capture.screenshot).toBeUndefined();

      await page.click('pierce/[aria-label="Delete annotation 1"]');
      expect(await page.evaluate(() => !!document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="annotation-tray"]'))).toBe(false);
      expect(await page.$('pierce/[data-testid="annotation-badge-1"]')).toBeNull();

      expect(await page.evaluate(() => window.__tachyonDmOverlay?.unmount())).toBe(true);
      expect(await page.evaluate(() => ({ root: !!document.querySelector("tachyon-design-mode"), cleanup: typeof window.__tachyonDmCleanup, api: typeof window.__tachyonDmOverlay }))).toEqual({ root: false, cleanup: "undefined", api: "undefined" });
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
      await page.type('pierce/[aria-label="Annotation comment"]', "Keep this visible");
      await page.click('pierce/[data-testid="annotation-add"]');
      await page.waitForFunction(() => !!document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="annotation-badge-1"]'));
      await page.$eval("#ephemeral", (node) => node.remove());
      await page.waitForFunction(() => document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="annotation-row-1"]')?.textContent?.includes("Target not found"));
      expect(await page.$('pierce/[data-testid="annotation-badge-1"]')).toBeNull();
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
      await page.type('pierce/[aria-label="Annotation comment"]', "Fix it");
      await page.click('pierce/[data-testid="annotation-add"]');
      await page.$eval('pierce/[data-testid="annotation-agent-select"]', (node) => { const select = node as HTMLSelectElement; select.value = "new-agent"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      await page.click('pierce/[data-testid="annotation-send"]');

      const sent = await page.evaluate(() => window.__tachyonDmQueue?.map((raw) => JSON.parse(raw)).find((item) => item.action === "annotation.send"));
      expect(sent).toEqual({ action: "annotation.send", targetAgent: "new-agent" });
      expect(await page.$('pierce/[data-testid="annotation-row-1"]')).not.toBeNull();
      await page.evaluate(() => window.__tachyonDmApplySendState?.({ status: "error", text: "Receipt not confirmed; annotations preserved." }));
      expect(await page.$eval('pierce/[role="status"]', (node) => node.textContent)).toContain("annotations preserved");
      expect(await page.$('pierce/[data-testid="annotation-row-1"]')).not.toBeNull();
      await page.evaluate(() => { window.__tachyonDmApplyAnnotationState?.([]); window.__tachyonDmApplySendState?.({ status: "sent", text: "Sent." }); });
      expect(await page.evaluate(() => !!document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="annotation-tray"]'))).toBe(false);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("freezes the viewport, keeps vector shapes across reinjection, and exports Copy/Send without touching the page DOM", async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 880, height: 600 });
      await page.setContent(`<main id="application" style="height:1600px"><button id="live">Live application</button></main>`);
      await page.evaluate((source) => { (0, eval)(source); }, bundle);
      await page.evaluate(() => {
        const frozen = document.createElement("canvas"); frozen.width = 880; frozen.height = 600;
        const context = frozen.getContext("2d")!; context.fillStyle = "#15202b"; context.fillRect(0, 0, 880, 600); context.fillStyle = "white"; context.fillText("Frozen viewport", 30, 40);
        let active = false; let markup = { frozen: frozen.toDataURL("image/png"), sourceUrl: "https://example.test/before", shapes: [] as unknown[] };
        window.tachyonDesignModePick = (raw) => {
          const request = JSON.parse(raw) as { action?: string; __annotation?: string; shapes?: unknown[] };
          if (request.action === "markup.capture") { active = true; window.__tachyonDmApplyMarkupState?.(markup); }
          if (request.action === "markup.sync" && active) window.__tachyonDmApplyMarkupState?.(markup);
          if (request.action === "markup.update") markup = { ...markup, shapes: request.shapes || [] };
          if (request.action === "markup.export") window.__tachyonDmApplyMarkupState?.({ ...markup, status: "copied", text: "persisted" });
          if (request.__annotation === "agents") window.__tachyonDmApplyAgentState?.({ agents: ["ada"], active: "ada" });
        };
        window.__tachyonDmOverlay?.mount({ bindingName: "tachyonDesignModePick", focusColor: "#007fd4", restorePickMode: false });
        window.__tachyonDmApplyAgentState?.({ agents: ["ada"], active: "ada" });
      });
      await page.click('pierce/[data-testid="markup-start"]');
      await page.waitForFunction(() => !!document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="markup-canvas"]'));
      const before = await page.$eval("#application", (node) => node.outerHTML);
      const box = await (await page.$('pierce/[data-testid="markup-canvas"]'))!.boundingBox();
      await page.mouse.move(box!.x + 40, box!.y + 50); await page.mouse.down(); await page.mouse.move(box!.x + 180, box!.y + 150, { steps: 5 }); await page.mouse.up();
      expect(await page.evaluate(() => document.querySelector("tachyon-design-mode")!.shadowRoot!.querySelectorAll('[data-testid="markup-canvas"] polyline').length)).toBe(1);
      expect(await page.$eval("#application", (node) => node.outerHTML)).toBe(before);
      await page.evaluate(() => scrollTo(0, 500));
      await page.setViewport({ width: 360, height: 640 });
      expect(await page.evaluate(() => document.querySelector("tachyon-design-mode")!.shadowRoot!.querySelectorAll('[data-testid="markup-canvas"] polyline').length)).toBe(1);
      await page.click('pierce/[data-testid="markup-copy"]');
      await page.waitForFunction(() => window.__tachyonDmQueue?.some((raw) => JSON.parse(raw).action === "markup.export" && JSON.parse(raw).intent === "copy"));
      await page.evaluate(() => { document.querySelector("#live")!.textContent = "Page navigated underneath"; window.__tachyonDmOverlay?.unmount(); });
      await page.evaluate((source) => { (0, eval)(source); window.__tachyonDmOverlay?.mount({ bindingName: "tachyonDesignModePick", focusColor: "#007fd4", restorePickMode: false }); }, bundle);
      await page.waitForFunction(() => !!document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="markup-canvas"] polyline'));
      expect(await page.$eval("#live", (node) => node.textContent)).toBe("Page navigated underneath");
      await page.click('pierce/[data-testid="markup-send"]');
      await page.waitForFunction(() => window.__tachyonDmQueue?.some((raw) => JSON.parse(raw).action === "markup.export" && JSON.parse(raw).intent === "send"));
      expect(await page.evaluate(() => document.querySelector("tachyon-design-mode")!.shadowRoot!.querySelectorAll('[data-testid="markup-canvas"] polyline').length)).toBe(1);
    } finally { await page.close(); }
  }, HANG_TIMEOUT_MS);

  for (const width of [880, 360]) it(`shows agent selector, four presets, and PNG preview at ${width}px`, async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width, height: 700 });
      await page.setContent(`<style>html{font-size:62.5%}*{font:48px/3 serif!important;color:hotpink!important;background:lime!important;border-radius:0!important}button{padding:40px!important}</style><main><button id="cta">Target</button></main>`);
      await page.evaluate((source) => { (0, eval)(source); }, bundle);
      await page.evaluate(() => {
        window.tachyonDesignModePick = (raw) => {
          const request = JSON.parse(raw) as { action?: string; preset?: string };
          if (request.action === "viewport.set") window.__tachyonDmApplyViewportState?.({ preset: request.preset as "phone", status: "success" });
          if (request.action === "markup.capture") {
            const canvas = document.createElement("canvas"); canvas.width = innerWidth; canvas.height = innerHeight;
            const context = canvas.getContext("2d")!; context.fillStyle = "#f4f1ea"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "#243447"; context.fillRect(0, 0, canvas.width, 64); context.fillStyle = "white"; context.font = "bold 22px sans-serif"; context.fillText("Frozen product viewport", 24, 40); context.fillStyle = "#445"; context.font = "16px sans-serif"; context.fillText("Draw feedback safely over this captured image", 24, 112);
            window.__tachyonDmApplyMarkupState?.({ frozen: canvas.toDataURL("image/png"), sourceUrl: location.href, shapes: [] });
          }
        };
        window.__tachyonDmOverlay?.mount({ bindingName: "tachyonDesignModePick", focusColor: "#007fd4", restorePickMode: false });
      });
      await page.waitForFunction(() => typeof window.__tachyonDmApplyAnnotationState === "function" && typeof window.__tachyonDmApplyAgentState === "function");
      await page.evaluate(() => {
        window.__tachyonDmApplyAgentState?.({ agents: ["ada"], active: "ada" });
        window.__tachyonDmApplyAnnotationState?.([{ index: 1, intent: "change", comment: "Preview this", screenshotPath: "/tmp/pick.png", screenshotPreview: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", page: { url: "https://example.test", title: "", viewport: { width: 1, height: 1 }, scroll: { x: 0, y: 0 }, dpr: 1, capturedAt: "now" }, target: { selector: "#cta", tag: "BUTTON", id: "cta", className: "", text: "Target", html: "", attributes: {}, accessibility: { role: "", label: "" }, bounds: { x: 0, y: 0, width: 1, height: 1 }, pageBounds: { x: 0, y: 0, width: 1, height: 1 }, styles: {} }, context: { parentText: "", previousText: "", nextText: "" } }]);
      });
      await page.waitForFunction(() => !!document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="annotation-preview-1"]'));
      expect(await page.evaluate(() => Array.from(document.querySelector("tachyon-design-mode")!.shadowRoot!.querySelectorAll('[data-testid="viewport-toolbar"] button:not([data-testid="markup-start"])'), (node) => node.textContent))).toEqual(["Phone 375×812", "Tablet 768×1024", "Desktop 1280×800", "Reset"]);
      expect(await page.$('pierce/[data-testid="annotation-agent-select"]')).not.toBeNull();
      expect(await page.$eval('pierce/[data-testid="annotation-preview-1"]', (node) => (node as HTMLImageElement).src.startsWith("data:image/png;base64,"))).toBe(true);
      await page.click('pierce/[data-testid="viewport-phone"]');
      expect(await page.evaluate(() => window.__tachyonDmQueue?.map((raw) => JSON.parse(raw)).find((item) => item.action === "viewport.set"))).toEqual({ action: "viewport.set", preset: "phone" });
      const coverage = await page.evaluate(() => {
        const root = document.querySelector("tachyon-design-mode")!.shadowRoot!;
        const nodes = [root.querySelector('[data-testid="viewport-toolbar"]'), root.querySelector('[data-testid="annotation-tray"]')] as HTMLElement[];
        return nodes.reduce((sum, node) => sum + node.getBoundingClientRect().width * node.getBoundingClientRect().height, 0) / (innerWidth * innerHeight);
      });
      expect(coverage).toBeLessThan(0.6);
      expect(await page.$eval('pierce/[data-testid="viewport-phone"]', (node) => ({ font: getComputedStyle(node).fontSize, color: getComputedStyle(node).color, height: node.getBoundingClientRect().height }))).toMatchObject({ font: "13px", color: "rgb(255, 255, 255)" });
      const evidenceDir = path.resolve(".vqa/visual-qa");
      fs.mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: path.join(evidenceDir, `design-mode-overlay-${width}.png`) as `${string}.png` });
      await page.click('pierce/[data-testid="markup-start"]');
      await page.waitForFunction(() => !!document.querySelector("tachyon-design-mode")?.shadowRoot?.querySelector('[data-testid="markup-editor"]'));
      await page.screenshot({ path: path.join(evidenceDir, `design-mode-markup-${width}.png`) as `${string}.png` });
    } finally { await page.close(); }
  }, HANG_TIMEOUT_MS);
});
