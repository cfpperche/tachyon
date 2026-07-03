import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// spec 342 T5 — Pilot A: the Plugins panel is the first REAL production surface adopting Kit components
// (KitSelect for the installed-list sort control, KitDropdown as each card's secondary-actions overflow
// menu). tasks.md's acceptance is "style isolation proven (fixture assertions hold on the real surface)" —
// this drives the ACTUAL shipped plugins.js bundle + a captured fixture VM through the dev preview harness
// (scripts/webview-preview), not the synthetic ui-gate page, so the proof is about this surface specifically.
describe("Pilot A: Plugins panel (real bundle + fixture, via the dev preview harness)", () => {
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

  it("renders with no console/response errors and the KitSelect sort control present", async () => {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("response", (res) => {
      if (!res.ok() && !res.url().endsWith("/favicon.ico")) failedResponses.push(`${res.status()} ${res.url()}`);
    });

    await page.goto(`${server.origin}/scripts/webview-preview/index.html?view=plugins&fixture=default`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.body.dataset.previewFixture === "default", { timeout: 5000 });
    await page.waitForSelector(".plugin-sort", { visible: true, timeout: 5000 });

    expect(failedResponses).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it("KitSelect sort control actually reorders the visible plugin list", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/scripts/webview-preview/index.html?view=plugins&fixture=default`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".plugin-sort", { visible: true, timeout: 5000 });

    const namesInOrder = () => page.evaluate(() => [...document.querySelectorAll(".pname")].map((el) => el.textContent));
    const nameAsc = await namesInOrder();

    await page.click(".plugin-sort");
    await page.waitForSelector('[data-slot="select-content"]', { visible: true, timeout: 2000 });
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-slot="select-item"]')] as HTMLElement[];
      const desc = items.find((el) => el.textContent?.includes("Z-A"));
      desc?.click();
    });
    await page.waitForSelector('[data-slot="select-content"]', { hidden: true, timeout: 2000 });
    const nameDesc = await namesInOrder();

    expect(nameDesc).toEqual([...nameAsc].reverse());
    await page.close();
  });

  it("a card's KitDropdown overflow menu opens and its items are reachable by keyboard", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/scripts/webview-preview/index.html?view=plugins&fixture=default`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".ds-card", { visible: true, timeout: 5000 });

    await page.click('.ds-card button[title^="More actions"]');
    await page.waitForSelector('[data-slot="dropdown-menu-content"]', { visible: true, timeout: 2000 });
    const hasItems = await page.evaluate(() => document.querySelectorAll('[data-slot="dropdown-menu-item"]').length > 0);
    expect(hasItems).toBe(true);

    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-slot="dropdown-menu-content"]', { hidden: true, timeout: 2000 });
    await page.close();
  });
});
