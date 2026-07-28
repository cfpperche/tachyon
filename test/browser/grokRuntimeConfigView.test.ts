import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

/**
 * SDD 481 — Grok Runtime Config, measured in a real browser against the shipped bundle.
 *
 * This exists because the Dev Host is not available to an agent: opening VS Code / an Extension
 * Development Host is a human-only action in this project (recorded in the spec's tasks.md), so the
 * UI half of this slice needed a check that runs headlessly. The webview preview server renders the
 * SAME `Cockpit` bundle and the SAME stylesheets the extension ships, driven by the same
 * `runtimeConfigSnapshotMessage` envelope — what it does not exercise is the extension host behind
 * it, which is why the save path is asserted host-side in the unit suite and by the round-trip
 * dogfood instead.
 *
 * Not part of `verify:full` (needs a system Chrome and a built `dist/`). Run with:
 *
 *     npm run build && npx vitest run --config vitest.browser.config.ts test/browser/grokRuntimeConfigView.test.ts
 */
const PREVIEW = "/scripts/webview-preview/index.html?view=cockpit&fixture=runtime-config";

/**
 * The runtime dropdown is the Kit (Radix) dropdown, which opens on `pointerdown` — measured
 * 2026-07-28: a trailing `click()` toggles it straight back shut, so this dispatches pointerdown and
 * nothing else, then selects the item with a full pointer sequence.
 */
async function selectGrok(page: Page): Promise<void> {
  await page.evaluate(() => {
    const trigger = document.querySelector('[data-testid="runtime-config-runtime-trigger"]');
    (trigger as HTMLElement).dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true,
    }));
  });
  await page.waitForSelector('[data-testid="runtime-config-runtime-grok"]', { timeout: 5000 });
  await page.evaluate(() => {
    const item = document.querySelector('[data-testid="runtime-config-runtime-grok"]') as HTMLElement;
    const options = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true };
    item.dispatchEvent(new PointerEvent("pointermove", options));
    item.dispatchEvent(new PointerEvent("pointerdown", options));
    item.dispatchEvent(new PointerEvent("pointerup", options));
    item.click();
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="runtime-config-runtime-trigger"]')?.textContent?.includes("Grok"),
    { timeout: 5000 },
  );
}

async function openDocument(page: Page, label: string): Promise<void> {
  await page.evaluate((name) => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes(name));
    (button as HTMLButtonElement | undefined)?.click();
  }, label);
  await page.waitForFunction(
    (name) => document.querySelector(".rcp-segmented button.active")?.textContent?.includes(name),
    { timeout: 5000 },
    label,
  );
}

const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

describe("Grok Runtime Config view (SDD 481)", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    await page.goto(`${server.origin}${PREVIEW}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="control-runtime-config"]', { visible: true, timeout: 10_000 });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("offers Grok in the runtime dropdown and switches to its three documents", async () => {
    await selectGrok(page);
    const documents = await page.evaluate(() =>
      [...document.querySelectorAll(".rcp-segmented button")].map((button) => button.textContent?.trim() ?? ""));
    expect(documents.some((label) => label.includes("Global config"))).toBe(true);
    expect(documents.some((label) => label.includes("Workspace config"))).toBe(true);
    expect(documents.some((label) => label.includes("Folder trust"))).toBe(true);
  });

  it("states, on the global document, that managed agents do not inherit it", async () => {
    await openDocument(page, "Global config");
    const impact = await page.$eval('[data-testid="runtime-config-impact"]', (element) => element.textContent ?? "");
    expect(impact).toContain("private GROK_HOME");
    expect(impact).toContain("outside Tachyon");
  });

  it("renders the measured scalars, including a real number input, and marks authority keys read-only", async () => {
    await openDocument(page, "Global config");
    const numberInputs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>(".rcp-setting-editor input[type='number']")].map((input) => input.value));
    expect(numberInputs).toContain("120");

    const permission = await page.evaluate(() => {
      const label = [...document.querySelectorAll("label")]
        .find((candidate) => candidate.textContent?.includes("Permission mode"));
      const input = label?.parentElement?.querySelector("input");
      return {
        note: label?.querySelector(".rcp-setting-note")?.textContent ?? "",
        disabled: input instanceof HTMLInputElement ? input.disabled : null,
        value: input instanceof HTMLInputElement ? input.value : null,
      };
    });
    expect(permission.disabled).toBe(true);
    expect(permission.note).toContain("authority");
    expect(permission.value).toBe("always-approve");
  });

  it("offers no scalar editor on the workspace document and says why", async () => {
    await openDocument(page, "Workspace config");
    const settings = await page.$$(".rcp-setting--editable");
    expect(settings).toHaveLength(0);
    const impact = await page.$eval('[data-testid="runtime-config-impact"]', (element) => element.textContent ?? "");
    expect(impact).toContain("Only [mcp_servers] is read in project scope");
    expect(await bodyText(page)).toContain("repo_tools");
  });

  it("shows folder trust as read-only, with no save affordance at all", async () => {
    await openDocument(page, "Folder trust");
    expect(await page.$('[data-testid="runtime-config-read-only"]')).not.toBeNull();
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll(".rcp-actions-bar button")].map((button) => button.textContent?.trim() ?? ""));
    expect(buttons).toHaveLength(0);
    expect(await bodyText(page)).toContain("This workspace is trusted");
  });

  it("never renders a payload, and never scrolls the panel sideways", async () => {
    for (const label of ["Global config", "Workspace config", "Folder trust"]) {
      await openDocument(page, label);
      const text = await bodyText(page);
      // The fixture spells every payload-shaped value this way on purpose.
      expect(text).not.toContain("fixture-never-render-");
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth,
      )).toBe(true);
    }
  });
});
