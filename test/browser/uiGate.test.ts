import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// spec 342 T1 — pipeline scaffold smoke test: prove the whole chain (esbuild ui-gate bundle + Tailwind CSS +
// the real webview shell + a real system-Chrome page load) works end to end BEFORE any vendored component
// lands. T3 replaces the placeholder assertions here with the per-component compat-gate checklist.
describe("ui-gate pipeline scaffold", () => {
  let server: GateServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("loads the gate page with no console errors", async () => {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    // Chrome's browser-level favicon.ico probe 404s on every page regardless of app markup; track failed
    // RESPONSES (which carry the URL) instead of console text (which doesn't), so the favicon noise is
    // excluded by URL rather than by hoping its console message looks different from a real asset 404.
    const failedResponses: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("response", (res) => {
      if (!res.ok() && !res.url().endsWith("/favicon.ico")) failedResponses.push(`${res.status()} ${res.url()}`);
    });

    const response = await page.goto(server.url, { waitUntil: "networkidle0" });
    expect(response?.ok()).toBe(true);

    const title = await page.title();
    expect(title).toBe("Tachyon UI Gate");

    const rootText = await page.$eval("#gate-root", (el) => el.textContent);
    expect(rootText).toContain("ui-gate: pipeline scaffold");

    expect(failedResponses).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });
});
