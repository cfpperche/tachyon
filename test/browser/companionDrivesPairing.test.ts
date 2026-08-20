import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

let browser: Browser;
let server: GateServer;

beforeAll(async () => {
  server = await startGateServer();
  browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, HANG_TIMEOUT_MS);

afterAll(async () => { await browser?.close(); await server?.close(); });

async function recordPostedMessages(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const target = window as unknown as { __posted?: unknown[] };
    target.__posted = [];
    let assigned: ((...args: unknown[]) => unknown) | undefined;
    Object.defineProperty(window, "acquireVsCodeApi", {
      configurable: true,
      get() { return (...args: unknown[]) => { const api = assigned?.(...args) as { postMessage?: (message: unknown) => void } | undefined; if (api?.postMessage) { const original = api.postMessage.bind(api); api.postMessage = (message) => { target.__posted!.push(message); original(message); }; } return api; }; },
      set(fn: unknown) { assigned = fn as (...args: unknown[]) => unknown; },
    });
  });
}

describe("t-a90049 — Companion pairing is driven through the app", () => {
  it("generates a code, shows countdown, and revokes a device", async () => {
    const page = await browser.newPage();
    try {
      await recordPostedMessages(page);
      const surface = await openPreview(page, server.origin, { query: { view: "companion", fixture: "default" }, width: 880, waitFor: ".companion-root" });
      await surface.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Show pair code")?.click());
      const requested = await surface.evaluate(() => (window as unknown as { __posted: Array<{ type?: string }> }).__posted.some((message) => message.type === "issueCompanionPairCode"));
      expect(requested, "Show pair code must dispatch the host operation").toBe(true);

      await surface.evaluate(() => window.postMessage({ type: "companionPairOffer", offer: { ok: true, code: "123456", baseUrl: "http://127.0.0.1:7421", openUrl: "http://127.0.0.1:7421/companion/app/#pair=123456", qrDataUrl: "data:image/png;base64,fixture", expiresAt: new Date(Date.now() + 3_000).toISOString() } }, "*"));
      await surface.waitForSelector('[data-testid="companion-pair-code"]', { visible: true, timeout: 5_000 });
      const firstCountdown = await surface.$eval('[data-testid="companion-pair-expires"]', (node) => node.textContent ?? "");
      expect(firstCountdown).toContain("Expires");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const secondCountdown = await surface.$eval('[data-testid="companion-pair-expires"]', (node) => node.textContent ?? "");
      expect(secondCountdown).not.toBe(firstCountdown);

      await surface.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Unpair")?.click());
      const revoked = await surface.evaluate(() => (window as unknown as { __posted: Array<{ type?: string; deviceId?: string }> }).__posted.find((message) => message.type === "unpairCompanionDevice"));
      expect(revoked?.deviceId).toBe("fixture-dev");
    } finally { await page.close(); }
  }, HANG_TIMEOUT_MS);
});
