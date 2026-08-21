import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-eaffa5 — Lifecycle Rename / Forget / Clone open as KitDialog over the form, not as panels
 * in the page flow. The production door is the shipped Agent Studio bundle in the preview harness.
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

async function openLifecycle(page: import("puppeteer-core").Page, fixture: string, width: number) {
  return openPreview(page, server.origin, {
    query: { view: "agent-studio-shell", fixture, ashTab: "lifecycle" },
    width,
    height: 1100,
    waitFor: "#ash-lifecycle-title",
  });
}

async function clickLabeled(surface: Frame, label: string): Promise<void> {
  const clicked = await surface.evaluate((wanted) => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === wanted);
    if (!button) return false;
    button.click();
    return true;
  }, label);
  expect(clicked, `button '${label}' missing`).toBe(true);
}

function measureDialog(surface: Frame, testId: string) {
  return surface.evaluate((id) => {
    const content = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    const identity = document.querySelector(".ash-identity");
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    const rect = content?.getBoundingClientRect();
    return {
      present: !!content,
      role: content?.getAttribute("role") ?? null,
      containedByIdentity: !!(identity && content && identity.contains(content)),
      portalIsBodyChild: content?.closest("[data-slot='dialog-portal-tree']")?.parentElement === document.body,
      overlayPresent: !!overlay,
      visibleCount: document.querySelectorAll('[data-slot="dialog-content"]').length,
      titleInIdentity: !!document.querySelector(".ash-identity #ash-rename-confirm-title, .ash-identity #ash-forget-confirm-title, .ash-identity #ash-bundle-action-title"),
      focusInside: !!(content && document.activeElement && content.contains(document.activeElement)),
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), bottom: Math.round(rect.bottom) } : null,
      viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
    };
  }, testId);
}

describe("t-eaffa5 — Agent Studio lifecycle panels are dialogs", () => {
  it("Rename opens as a portaled dialog, traps focus, and Escape closes it", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openLifecycle(page, "canonical-disabled", 880);
      await clickLabeled(surface, "Rename…");
      await surface.waitForSelector('[data-testid="ash-rename-dialog"]', { visible: true, timeout: HANG_TIMEOUT_MS });
      const open = await measureDialog(surface, "ash-rename-dialog");
      expect(open.present).toBe(true);
      expect(open.role).toBe("dialog");
      expect(open.containedByIdentity).toBe(false);
      expect(open.portalIsBodyChild).toBe(true);
      expect(open.overlayPresent).toBe(true);
      expect(open.titleInIdentity).toBe(false);
      expect(open.visibleCount).toBe(1);
      expect(open.focusInside).toBe(true);

      await page.keyboard.press("Tab");
      const stillTrapped = await surface.evaluate(() => {
        const content = document.querySelector('[data-testid="ash-rename-dialog"]');
        return !!content && content.contains(document.activeElement);
      });
      expect(stillTrapped).toBe(true);

      await page.keyboard.press("Escape");
      await surface.waitForSelector('[data-testid="ash-rename-dialog"]', { hidden: true, timeout: HANG_TIMEOUT_MS });
      const closed = await measureDialog(surface, "ash-rename-dialog");
      expect(closed.present).toBe(false);
      expect(closed.visibleCount).toBe(0);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("Forget-plan fixture opens as a dialog and keeps the typed-name gate", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openLifecycle(page, "forget-plan", 880);
      await surface.waitForSelector('[data-testid="ash-forget-dialog"]', { visible: true, timeout: HANG_TIMEOUT_MS });
      const open = await measureDialog(surface, "ash-forget-dialog");
      expect(open.present).toBe(true);
      expect(open.role).toBe("dialog");
      expect(open.containedByIdentity).toBe(false);
      expect(open.portalIsBodyChild).toBe(true);
      expect(open.titleInIdentity).toBe(false);

      const gate = await surface.evaluate(() => {
        const approve = [...document.querySelectorAll('[data-testid="ash-forget-dialog"] button')]
          .find((button) => button.textContent?.trim() === "Approve and execute") as HTMLButtonElement | undefined;
        const confirm = document.querySelector('[aria-label="Agent name confirmation"]') as HTMLInputElement | null;
        return { disabled: approve?.disabled ?? null, hasConfirm: !!confirm, confirmValue: confirm?.value ?? "" };
      });
      expect(gate.hasConfirm).toBe(true);
      expect(gate.disabled).toBe(true);

      await surface.type('[aria-label="Agent name confirmation"]', "reviewer");
      const armed = await surface.evaluate(() => {
        const approve = [...document.querySelectorAll('[data-testid="ash-forget-dialog"] button')]
          .find((button) => button.textContent?.trim() === "Approve and execute") as HTMLButtonElement | undefined;
        return approve?.disabled ?? null;
      });
      expect(armed).toBe(false);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("Clone opens as a portaled dialog, not in the body flow", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openLifecycle(page, "canonical-disabled", 880);
      await clickLabeled(surface, "Clone…");
      await surface.waitForSelector('[data-testid="ash-bundle-dialog"]', { visible: true, timeout: HANG_TIMEOUT_MS });
      const open = await measureDialog(surface, "ash-bundle-dialog");
      expect(open.present).toBe(true);
      expect(open.role).toBe("dialog");
      expect(open.containedByIdentity).toBe(false);
      expect(open.portalIsBodyChild).toBe(true);
      expect(open.visibleCount).toBe(1);
      const title = await surface.evaluate(() => document.querySelector("#ash-bundle-action-title")?.textContent ?? "");
      expect(title).toBe("Clone portable profile");
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("a click on the Forget button while Rename is open does not leave two dialogs", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openLifecycle(page, "canonical-disabled", 880);
      await clickLabeled(surface, "Rename…");
      await surface.waitForSelector('[data-testid="ash-rename-dialog"]', { visible: true, timeout: HANG_TIMEOUT_MS });

      const forgetBox = await surface.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Forget…");
        const rect = button?.getBoundingClientRect();
        return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
      });
      expect(forgetBox, "Forget… is not in the document").toBeTruthy();
      const frame = await page.$("iframe#frame");
      const frameBox = await frame?.boundingBox();
      expect(frameBox).toBeTruthy();
      await page.mouse.click(frameBox!.x + forgetBox!.x, frameBox!.y + forgetBox!.y);

      const after = await surface.evaluate(() => ({
        rename: !!document.querySelector('[data-testid="ash-rename-dialog"]'),
        forget: !!document.querySelector('[data-testid="ash-forget-dialog"]'),
        visible: document.querySelectorAll('[data-slot="dialog-content"]').length,
      }));
      expect(after.visible).toBeLessThanOrEqual(1);
      expect(after.rename && after.forget).toBe(false);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("at 880px the dialog is centered with a reading width", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openLifecycle(page, "canonical-disabled", 880);
      await clickLabeled(surface, "Rename…");
      await surface.waitForSelector('[data-testid="ash-rename-dialog"]', { visible: true, timeout: HANG_TIMEOUT_MS });
      const atWide = await measureDialog(surface, "ash-rename-dialog");
      expect(atWide.rect).toBeTruthy();
      expect(atWide.rect!.x).toBeGreaterThan(40);
      expect(atWide.rect!.x + atWide.rect!.w).toBeLessThan(atWide.viewport.w - 40);
      const wideMid = atWide.rect!.y + atWide.rect!.h / 2;
      expect(wideMid).toBeGreaterThan(atWide.viewport.h * 0.25);
      expect(wideMid).toBeLessThan(atWide.viewport.h * 0.75);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("at 360px the same dialog docks to the bottom as a sheet", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openLifecycle(page, "canonical-disabled", 360);
      await clickLabeled(surface, "Rename…");
      await surface.waitForSelector('[data-testid="ash-rename-dialog"]', { visible: true, timeout: HANG_TIMEOUT_MS });
      const atNarrow = await measureDialog(surface, "ash-rename-dialog");
      expect(atNarrow.rect).toBeTruthy();
      expect(atNarrow.rect!.x).toBeLessThanOrEqual(1);
      expect(atNarrow.rect!.w).toBeGreaterThan(atNarrow.viewport.w - 2);
      expect(Math.abs(atNarrow.rect!.bottom - atNarrow.viewport.h)).toBeLessThan(2);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);
});
