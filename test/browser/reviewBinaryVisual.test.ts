import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

/**
 * t-3be62b visual anchor, written from the task before the captures:
 * Binary evidence is visible in Review, contained inside the diff pane, and legible in both themes.
 * Raster/SVG retain their proportions; PDF presents a readable page; 3D presents an interactive viewport.
 */
describe("t-3be62b — Review binary families", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    page = await browser.newPage();
    await page.setViewport({ width: 920, height: 940, deviceScaleFactor: 2 });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  it("does not request either heavy viewer for a text-only review", async () => {
    const requested: string[] = [];
    const listener = (request: { url(): string }) => requested.push(request.url());
    page.on("request", listener);
    await openPreview(page, server.origin, { query: { view: "review", fixture: "default" }, waitFor: ".review-diff" });
    page.off("request", listener);
    expect(requested.some((url) => /review-(?:pdf|model-viewer)\.js$/.test(url))).toBe(false);
    expect(requested.some((url) => url.endsWith("pdf.worker.min.mjs"))).toBe(false);
  });

  it("keeps binary evidence contained at the repository's 360px narrow width", async () => {
    const surface = await openPreview(page, server.origin, {
      query: { view: "review", fixture: "raster", theme: "dark" }, width: 360, height: 900, waitFor: ".review-binary-image",
    });
    const geometry = await surface.$eval(".review-binary-image", (node) => {
      const image = node.getBoundingClientRect();
      const pane = node.closest(".review-pane")!.getBoundingClientRect();
      return { imageLeft: image.left, imageRight: image.right, paneLeft: pane.left, paneRight: pane.right };
    });
    expect(geometry.imageLeft).toBeGreaterThanOrEqual(geometry.paneLeft);
    expect(geometry.imageRight).toBeLessThanOrEqual(geometry.paneRight + 1);
  });

  for (const family of ["raster", "svg", "pdf", "model"] as const) {
    for (const theme of ["light", "dark"] as const) {
      it(`renders ${family} in ${theme}`, async () => {
        const surface = await openPreview(page, server.origin, {
          query: { view: "review", fixture: family, theme }, width: 880, height: 900,
          waitFor: family === "model" ? "model-viewer" : family === "pdf" ? ".review-pdf canvas" : family === "svg" ? "img.review-binary-svg" : ".review-binary-image",
          timeout: 30_000,
        });
        if (family === "pdf") {
          await surface.waitForFunction(() => (document.querySelector(".review-pdf canvas") as HTMLCanvasElement | null)?.width! > 0);
          expect(await surface.$eval(".review-pdf", (node) => node.textContent)).not.toContain("failed to render");
        }
        if (family === "svg") {
          const sanitized = decodeURIComponent(await surface.$eval("img.review-binary-svg", (node) => node.getAttribute("src") ?? ""));
          expect(sanitized).not.toMatch(/<script|onload=/i);
          expect(sanitized).toContain("viewBox=\"0 0 640 360\"");
        }
        if (family === "model") await surface.waitForFunction(() => document.querySelector("model-viewer")?.shadowRoot !== null);
      }, 45_000);
    }
  }
});
