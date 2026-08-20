import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-49f6e8 — error RECOVERY, driven. The previous fix named the unsaveable row; the owner's next
 * two minutes on the devhost measured what naming alone is worth: 0 remove controls against 2 add
 * controls, so a stray "Add value" blocked Save until the user invented a name for a field they
 * did not want. There was no way back, and the red line at the top did not lead anywhere.
 *
 * This suite drives the three recoveries the card demands:
 *   destroy  — Add value without filling, REMOVE the row, Save comes back (and the same for a
 *              secret reference);
 *   reach    — with the error on screen and the form on a DIFFERENT tab, the error itself is the
 *              path: clicking it switches to the owning tab and focuses the guilty field
 *              (WCAG G139 "jump to errors", GOV.UK error-summary links).
 *
 * Watched red on the pre-fix build: no remove controls and no clickable errors exist.
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

async function openEdit(page: Page) {
  return openPreview(page, server.origin, { query: { view: "agent-studio-shell", fixture: "canonical-disabled" }, width: 880, waitFor: ".sf-region-fields" });
}

/** one benign edit so the form is dirty and Save's enabled state is about ERRORS, not emptiness */
async function makeDirty(surface: Frame) {
  await surface.evaluate(() => {
    const check = document.querySelector(".ash-check-grid input") as HTMLInputElement | null;
    if (check) { check.click(); }
  });
}

const read = () => ({
  blocking: [...document.querySelectorAll(".sf-error-blocking")].map((e) => (e.textContent ?? "").trim()),
  save: (() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save");
    return button ? (button as HTMLButtonElement).disabled : null;
  })(),
});

describe("t-49f6e8 — an error has a way out", () => {
  it("a value row can be destroyed and Save recovers", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openEdit(page);
      await makeDirty(surface);
      await surface.evaluate(() => {
        const add = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add value");
        (add as HTMLButtonElement).click();
      });
      await surface.waitForSelector('[aria-label="Environment variable name"]', { timeout: 5_000 });
      const blocked = await surface.evaluate(read);
      expect(blocked.blocking.join(" | ")).toContain("Environment value");
      expect(blocked.save).toBe(true);
      const removed = await surface.evaluate(() => {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('[aria-label^="Remove value row"]')];
        const last = buttons[buttons.length - 1];
        if (!last) return false;
        last.click();
        return true;
      });
      expect(removed, "every created row must have a remove control").toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      const recovered = await surface.evaluate(read);
      expect(recovered.blocking.join(" | ")).not.toContain("Environment value");
      expect(recovered.save, "Save must work again once the stray row is gone").toBe(false);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("the error is the path to the field, from another tab", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openEdit(page);
      await surface.evaluate(() => {
        const add = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add value");
        (add as HTMLButtonElement).click();
      });
      await surface.waitForSelector('[aria-label="Environment variable name"]', { timeout: 5_000 });
      const before = await surface.evaluate(() => ({
        tab: document.querySelector(".ds-tabs .ds-tab.active")?.textContent?.trim() ?? null,
        jump: [...document.querySelectorAll(".sf-error-blocking button")].length,
      }));
      expect(before.tab, "the fixture must start away from the field").toBe("General");
      expect(before.jump, "a blocking error that names a row must be clickable").toBeGreaterThan(0);
      const jumped = await surface.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(".sf-error-blocking button");
        if (!button) return false;
        button.click();
        return true;
      });
      expect(jumped).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      const after = await surface.evaluate(() => {
        const input = [...document.querySelectorAll<HTMLInputElement>('[aria-label="Environment variable name"]')].pop();
        return {
          tab: document.querySelector(".ds-tabs .ds-tab.active")?.textContent?.trim() ?? null,
          focused: document.activeElement === input,
          visible: input ? input.getBoundingClientRect().height > 0 : false,
          marked: input?.getAttribute("aria-invalid") === "true",
        };
      });
      expect(after.tab, "clicking the error must switch to the owning tab").toBe("Environment");
      expect(after.focused, "and focus the guilty field").toBe(true);
      expect(after.visible).toBe(true);
      expect(after.marked, "the guilty field carries aria-invalid").toBe(true);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("a secret reference can be destroyed too, and its error leads to its field", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openEdit(page);
      await makeDirty(surface);
      await surface.evaluate(() => {
        const add = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add secret reference");
        (add as HTMLButtonElement).click();
      });
      await surface.waitForSelector('[aria-label="Secret environment variable name"]', { timeout: 5_000 });
      const blocked = await surface.evaluate(read);
      expect(blocked.blocking.join(" | ")).toContain("Secret reference");
      expect(blocked.save).toBe(true);
      // the error leads to the field from the General tab
      await surface.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(".sf-error-blocking button");
        button?.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      const afterJump = await surface.evaluate(() => ({
        tab: document.querySelector(".ds-tabs .ds-tab.active")?.textContent?.trim() ?? null,
        focused: document.activeElement
          ? document.activeElement.getAttribute("aria-label") === "Secret environment variable name"
          : false,
      }));
      expect(afterJump.tab).toBe("Environment");
      expect(afterJump.focused).toBe(true);
      const removed = await surface.evaluate(() => {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('[aria-label^="Remove secret reference row"]')];
        const last = buttons[buttons.length - 1];
        if (!last) return false;
        last.click();
        return true;
      });
      expect(removed, "every created secret row must have a remove control").toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      const recovered = await surface.evaluate(read);
      expect(recovered.blocking.join(" | ")).not.toContain("Secret reference");
      expect(recovered.save, "Save must work again once the stray secret row is gone").toBe(false);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);
});
