import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-9aec3e — the test this card exists for. Every defect it names was found by a human TYPING on
 * the devhost form, and none of them appeared in a visual QA that only photographed it: capture
 * presses no key.
 *
 * So this suite DRIVES the shipped bundle:
 *   focus    — types a three-letter variable name into a freshly added environment row and asserts
 *              the focus is STILL in that input after the third keystroke (the old row was keyed
 *              by the name being typed, so every keystroke remounted it);
 *   refusal  — clicks Add value and asserts the form says WHICH row is unsaveable before Save can
 *              be clicked ("workspace command is invalid" named nothing);
 *   save     — fills the form for real, clicks Save, and asserts the patch the webview actually
 *              posted carries the named row and no empty key (intercepted on the vscode-api stub
 *              the preview harness installs, so this is the same dispatch path production uses).
 *
 * The "agent appears in the sidebar" half cannot happen in the preview (no host answers); the
 * commit path it would exercise is covered in test/unit by the adapter's commit suite plus the
 * serialize cases in agentStudioEnvironmentRows.test.ts.
 */

let browser: Browser;
let server: GateServer;

beforeAll(async () => {
  server = await startGateServer();
  browser = await puppeteer.launch({
    executablePath: resolveChromeExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, HANG_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Records every message the webview posts through `acquireVsCodeApi`, before the harness's own
 *  stub assignment runs — a setter keeps the assignment working while the calls get wrapped. */
async function recordPostedMessages(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const target = window as unknown as { __posted?: unknown[] };
    target.__posted = [];
    let assigned: ((...args: unknown[]) => unknown) | undefined;
    Object.defineProperty(window, "acquireVsCodeApi", {
      configurable: true,
      get() {
        return (...args: unknown[]) => {
          const api = assigned?.(...args) as { postMessage?: (msg: unknown) => void } | undefined;
          if (api && typeof api.postMessage === "function") {
            const original = api.postMessage.bind(api);
            api.postMessage = (msg: unknown) => { target.__posted!.push(msg); original(msg); };
          }
          return api;
        };
      },
      set(fn: unknown) { assigned = fn as (...args: unknown[]) => unknown; },
    });
  });
}

async function openDriven(page: Page, query: Record<string, string | number>) {
  return openPreview(page, server.origin, { query, width: 880, waitFor: ".sf-region-fields" });
}

describe("t-9aec3e — Agent Studio driven by a keyboard", () => {
  it("keeps focus in an environment row while its name is typed", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openDriven(page, { view: "agent-studio-shell", fixture: "new", ashStep: 3 });
      await surface.evaluate(() => {
        const add = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add value");
        (add as HTMLButtonElement).click();
      });
      const row = await surface.waitForSelector('[aria-label="Environment variable name"]', { timeout: 5_000 });
      await row.click();
      await page.keyboard.type("sdk", { delay: 60 });
      const read = await surface.evaluate(() => {
        const input = [...document.querySelectorAll<HTMLInputElement>('[aria-label="Environment variable name"]')].pop();
        return {
          value: input?.value ?? null,
          focused: document.activeElement === input,
          activeIsInput: document.activeElement instanceof HTMLInputElement,
        };
      });
      expect(read.value, "the typed name must land in the row").toBe("sdk");
      expect(read.focused, "focus must still be in the row's name input after the third keystroke").toBe(true);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("names the unsaveable row instead of refusing the whole payload anonymously", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openDriven(page, { view: "agent-studio-shell", fixture: "new", ashStep: 3 });
      await surface.evaluate(() => {
        const add = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add value");
        (add as HTMLButtonElement).click();
      });
      await surface.waitForSelector('[aria-label="Environment variable name"]', { timeout: 5_000 });
      const read = await surface.evaluate(() => ({
        refusals: [...document.querySelectorAll(".sf-error-blocking")].map((e) => (e.textContent ?? "").trim()),
        save: [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")
          ? ([...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save") as HTMLButtonElement).disabled
          : null,
      }));
      const refusal = read.refusals.join(" | ");
      expect(refusal, "the blank row must produce a blocking error").toContain("Environment value 1");
      expect(refusal, "the error must say what is missing").toContain("name");
      expect(read.save, "Save must be blocked while a blank row exists").toBe(true);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("saves for real: the posted patch carries the named row and no empty key", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      await recordPostedMessages(page);
      const surface = await openDriven(page, { view: "agent-studio-shell", fixture: "new", ashStep: 3 });
      const authored = await surface.evaluate(() => {
        const setInput = (selector: string, value: string) => {
          const input = document.querySelector(selector) as HTMLInputElement | null;
          if (!input) return false;
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        };
        const command = setInput("#ash-cmd", "claude");
        const name = setInput("#ash-name", "form-driver");
        const add = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add value");
        (add as HTMLButtonElement).click();
        return { command, name };
      });
      expect(authored.command && authored.name, "the form must be authorable").toBe(true);
      // type the row's name with real keys — the same gesture that used to lose focus
      const row = await surface.waitForSelector('[aria-label="Environment variable name"]', { timeout: 5_000 });
      await row.click();
      await page.keyboard.type("SDK", { delay: 40 });
      await surface.evaluate(() => {
        const value = [...document.querySelectorAll<HTMLInputElement>('[aria-label^="Value for"]')].pop();
        if (value) { value.value = "x"; value.dispatchEvent(new Event("input", { bubbles: true })); }
      });
      await new Promise((r) => setTimeout(r, 300));
      const saved = await surface.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save");
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
        button.click();
        return true;
      });
      expect(saved, "Save must be clickable once the row is named").toBe(true);
      await new Promise((r) => setTimeout(r, 400));
      const posted = await surface.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted);
      const patches = posted.filter((m) => (m as { type?: string }).type === "patch") as { patch: { editable?: { environment?: { values?: Record<string, string> } } } }[];
      const save = posted.some((m) => (m as { type?: string }).type === "save");
      expect(save, "the save gesture must reach the dispatch the host owns").toBe(true);
      const last = patches[patches.length - 1]?.patch?.editable?.environment?.values ?? {};
      expect(last.SDK, "the named row must travel in the payload").toBe("x");
      expect(Object.keys(last), "no blank key may ever leave the form").not.toContain("");
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);
});
