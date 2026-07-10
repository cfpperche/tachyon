import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

const PREVIEW_PATH = "/scripts/webview-preview/index.html?view=runtime-ops&fixture=";

interface Viewport {
  width: number;
  height: number;
}

async function openRuntimeOpsFixture(page: Page, origin: string, fixture: string, viewport: Viewport): Promise<void> {
  await page.setViewport(viewport);
  await page.goto(`${origin}${PREVIEW_PATH}${fixture}`, { waitUntil: "networkidle0" });
  await page.waitForFunction((name) => document.body.dataset.previewFixture === name, { timeout: 5000 }, fixture);
  await page.waitForSelector(".runtime-ops", { visible: true, timeout: 5000 });
  await page.evaluate((size) => {
    const frame = document.getElementById("frame")!;
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
  }, viewport);
}

async function hasNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
}

async function hasNoCellOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".runtime-ops-cell")]
    .every((cell) => cell.scrollWidth <= cell.clientWidth + 1));
}

describe("Runtime Ops view (spec 367 Phase 4)", () => {
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

  it("renders explicit loading, error, empty, mixed, throttled, stale Bridge, and duplicate-workspace fixtures", async () => {
    const loading = await browser.newPage();
    await openRuntimeOpsFixture(loading, server.origin, "loading", { width: 1100, height: 360 });
    expect(await loading.$eval(".runtime-ops", (el) => el.getAttribute("aria-busy"))).toBe("true");
    expect(await loading.$eval(".runtime-ops", (el) => el.textContent)).toContain("Loading runtime inventory...");
    await loading.close();

    const error = await browser.newPage();
    await openRuntimeOpsFixture(error, server.origin, "error", { width: 1100, height: 360 });
    expect(await error.$eval("[role='alert']", (el) => el.textContent)).toContain("Runtime Ops could not refresh the inventory.");
    expect(await error.$eval(".runtime-ops-refresh", (el) => el.getAttribute("href"))).toBe("command:tachyon.refreshRuntimeOps");
    await error.close();

    const empty = await browser.newPage();
    await openRuntimeOpsFixture(empty, server.origin, "empty", { width: 1100, height: 360 });
    expect(await empty.$eval(".runtime-ops-table", (el) => el.textContent)).toContain("No supported runtimes found.");
    await empty.close();

    const mixed = await browser.newPage();
    await openRuntimeOpsFixture(mixed, server.origin, "mixed", { width: 1100, height: 360 });
    expect(await mixed.$$eval(".runtime-ops-runtime-group", (rows) => rows.length)).toBe(3);
    expect(await mixed.$eval(".runtime-ops-summary", (el) => el.textContent)).toContain("Throttled");
    await mixed.close();

    const throttled = await browser.newPage();
    await openRuntimeOpsFixture(throttled, server.origin, "throttled", { width: 1100, height: 360 });
    await throttled.click(".runtime-ops-agents summary");
    const throttledText = await throttled.$eval(".runtime-ops", (el) => el.textContent ?? "");
    const throttledDom = await throttled.content();
    expect(throttledText).toContain("Throttled - see agent terminal");
    expect(throttledText).toContain("Codex · 5-hour window");
    expect(throttledText).toContain("Throttle runtime and scope unavailable");
    for (const marker of [
      "RAW_THROTTLE_RUNTIME_MUST_NOT_RENDER",
      "RAW_THROTTLE_SCOPE_MUST_NOT_RENDER",
      "RAW_THROTTLE_LINE_MUST_NOT_RENDER",
      "RAW_MODEL_VALUE_MUST_NOT_RENDER",
      "RAW_MODEL_REASON_MUST_NOT_RENDER",
      "RAW_CONTEXT_REASON_MUST_NOT_RENDER",
      "RAW_MATCHED_LINE_MUST_NOT_RENDER",
      "RAW_SESSION_ID_MUST_NOT_RENDER",
      "RAW_PATH_MUST_NOT_RENDER",
      "RAW_TOKEN_MUST_NOT_RENDER",
    ]) {
      expect(throttledText).not.toContain(marker);
      expect(throttledDom).not.toContain(marker);
    }
    await throttled.close();

    const staleBridge = await browser.newPage();
    await openRuntimeOpsFixture(staleBridge, server.origin, "stale-bridge", { width: 1100, height: 360 });
    await staleBridge.click(".runtime-ops-agents summary");
    expect(await staleBridge.$eval(".runtime-ops", (el) => el.textContent)).toContain("Bridge binding needs attention.");
    await staleBridge.close();

    const duplicateWorkspace = await browser.newPage();
    await openRuntimeOpsFixture(duplicateWorkspace, server.origin, "duplicate-workspace", { width: 1100, height: 360 });
    await duplicateWorkspace.click(".runtime-ops-agents summary");
    const duplicateText = await duplicateWorkspace.$eval(".runtime-ops", (el) => el.textContent ?? "");
    expect(duplicateText).toContain("apps/api");
    expect(duplicateText).toContain("tools/api");
    expect(await duplicateWorkspace.$$eval(".runtime-ops-agent-row", (rows) => rows.length)).toBe(2);
    await duplicateWorkspace.close();
  });

  it("uses the wide table at 1100x360 with keyboard-operable agent details and visible focus", async () => {
    const page = await browser.newPage();
    await openRuntimeOpsFixture(page, server.origin, "mixed", { width: 1100, height: 360 });

    expect(await page.$eval(".runtime-ops-row", (el) => getComputedStyle(el).display)).toBe("grid");
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
    expect(await hasNoCellOverflow(page)).toBe(true);

    await page.focus(".runtime-ops-agents summary");
    const focus = await page.$eval(".runtime-ops-agents summary", (el) => ({
      active: document.activeElement === el,
      outlineWidth: getComputedStyle(el).outlineWidth,
      outlineStyle: getComputedStyle(el).outlineStyle,
    }));
    expect(focus.active).toBe(true);
    expect(focus.outlineWidth).toBe("2px");
    expect(focus.outlineStyle).toBe("solid");

    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector(".runtime-ops-agents")?.hasAttribute("open"), { timeout: 2000 });
    expect(await page.$eval(".runtime-ops-agents", (el) => el.hasAttribute("open"))).toBe(true);
    expect(await page.$eval(".runtime-ops-agents summary", (el) => document.activeElement === el)).toBe(true);
    await page.close();
  });

  it("uses labeled rows at 340x760 without page or cell overflow, including long labels", async () => {
    const page = await browser.newPage();
    await openRuntimeOpsFixture(page, server.origin, "long-label", { width: 340, height: 760 });

    expect(await page.$eval(".runtime-ops-row", (el) => getComputedStyle(el).display)).toBe("flex");
    expect(await page.$eval(".runtime-ops-header", (el) => getComputedStyle(el).display)).toBe("none");
    await page.click(".runtime-ops-agents summary");
    expect(await page.$eval(".runtime-ops", (el) => el.textContent)).toContain("migration-coordinator-with-a-deliberately-long-operational-label");
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
    expect(await hasNoCellOverflow(page)).toBe(true);
    await page.close();
  });
});
