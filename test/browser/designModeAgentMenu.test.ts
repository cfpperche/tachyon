import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { buildDesignModeInjectExpression } from "../../src/webview/ide-browser-bridge/designModeInject.js";

/**
 * t-a4060b — the host now distinguishes why the Design Mode agent list is empty.
 * This file is the page door: the inject must render `payload.emptyReason`
 * instead of collapsing every empty list into "No running agents".
 */
const INJECT = buildDesignModeInjectExpression({
  bindingName: "tachyonDesignModePick",
});

const PAGE_HTML = `<!doctype html><html><body><h1 id="hero">page</h1></body></html>`;

async function install(page: Page): Promise<void> {
  await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
  const ok = await page.evaluate((expr) => Boolean(eval(expr)), INJECT);
  expect(ok).toBe(true);
  await page.waitForSelector("#tachyon-dm-agent");
}

async function pushAgents(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate((body) => {
    const push = (window as unknown as {
      __tachyonDmChatPush?: (p: Record<string, unknown>) => void;
    }).__tachyonDmChatPush;
    push?.(body);
  }, payload);
}

async function menuText(page: Page): Promise<string> {
  await page.click("#tachyon-dm-agent");
  await page.waitForSelector("#tachyon-dm-agent-menu:not([hidden]) button");
  return page.$eval("#tachyon-dm-agent-menu button", (el) => el.textContent ?? "");
}

describe("t-a4060b Design Mode agent menu emptyReason", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("shows the host reason for a disconnected page", async () => {
    const page = await browser.newPage();
    await install(page);
    await pushAgents(page, {
      type: "agents",
      agents: [],
      emptyReason: "Design Mode is disconnected from this page — reopen the IDE Browser.",
    });
    expect(await menuText(page)).toBe(
      "Design Mode is disconnected from this page — reopen the IDE Browser.",
    );
    await page.close();
  });

  it("shows the host reason for a failed query", async () => {
    const page = await browser.newPage();
    await install(page);
    await pushAgents(page, {
      type: "agents",
      agents: [],
      emptyReason: "Could not load running agents: engine unavailable",
    });
    expect(await menuText(page)).toBe("Could not load running agents: engine unavailable");
    await page.close();
  });

  it("shows the host reason when no agent is eligible", async () => {
    const page = await browser.newPage();
    await install(page);
    await pushAgents(page, {
      type: "agents",
      agents: [],
      emptyReason: "No agents are running.",
    });
    expect(await menuText(page)).toBe("No agents are running.");
    await page.close();
  });

  it("falls back to No running agents when the host omits emptyReason", async () => {
    const page = await browser.newPage();
    await install(page);
    await pushAgents(page, { type: "agents", agents: [] });
    expect(await menuText(page)).toBe("No running agents");
    await page.close();
  });
});
