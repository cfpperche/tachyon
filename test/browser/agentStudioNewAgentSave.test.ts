import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-093a0d + t-7e4225 — the shipped New Agent document, driven.
 *
 * t-093a0d: a disabled Save must say why (name and command on step 1). Unchecking worktree must
 * not light Save on an incomplete form.
 * t-7e4225: create Save lives in the last-step nav, not the header. Edit keeps header Save.
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

function readSave(surface: { evaluate: (fn: () => unknown) => Promise<unknown> }) {
  return surface.evaluate(() => {
    const text = (el: Element | null) => (el?.textContent ?? "").trim();
    const headerButtons = [...document.querySelectorAll(".sf-actions button")].map((b) => text(b));
    const navButtons = [...document.querySelectorAll(".ash-steps-nav button")].map((b) => text(b));
    const saveIn = (root: string) => {
      const button = [...document.querySelectorAll(`${root} button`)].find((b) => text(b) === "Save") as HTMLButtonElement | undefined;
      return button ? { present: true, disabled: button.disabled } : { present: false, disabled: null };
    };
    return {
      headerButtons,
      navButtons,
      headerSave: saveIn(".sf-actions"),
      navSave: saveIn(".ash-steps-nav"),
      refusals: [...document.querySelectorAll(".sf-error-blocking")].map((e) => text(e)),
      inlineRefusals: [...document.querySelectorAll(".ash-native-config-risk")].map((e) => text(e)),
      invalidIdentityFields: document.querySelectorAll('#ash-name[aria-invalid="true"], #ash-cmd[aria-invalid="true"]').length,
      worktreeOn: (document.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked ?? null,
    };
  }) as Promise<{
    headerButtons: string[];
    navButtons: string[];
    headerSave: { present: boolean; disabled: boolean | null };
    navSave: { present: boolean; disabled: boolean | null };
    refusals: string[];
    inlineRefusals: string[];
    invalidIdentityFields: number;
    worktreeOn: boolean | null;
  }>;
}

describe("t-093a0d / t-7e4225 — New Agent Save placement and reasons", () => {
  it("on untouched step 1, Save stays unavailable without announcing errors until Next", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openPreview(page, server.origin, {
        query: { view: "agent-studio-shell", fixture: "new" },
        width: 880,
        waitFor: ".sf-region-fields",
      });
      const read = await readSave(surface);
      expect(read.headerSave.present, "create must not put Save in the header").toBe(false);
      expect(read.headerButtons).toContain("Cancel");
      expect(read.navSave.present, "Save must not appear before the last step").toBe(false);
      expect(read.refusals, "an untouched form must not mount an alert summary").toEqual([]);
      expect(read.inlineRefusals, "an untouched form must not mark either identity field").toEqual([]);
      expect(read.invalidIdentityFields).toBe(0);

      await surface.evaluate(() => {
        const next = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith("Next"));
        (next as HTMLButtonElement | undefined)?.click();
      });
      await surface.waitForSelector(".sf-error-blocking", { timeout: 5_000 });
      const afterAdvance = await readSave(surface);
      expect(afterAdvance.refusals.join(" | ")).toMatch(/name before saving/i);
      expect(afterAdvance.refusals.join(" | ")).toMatch(/runtime command before saving/i);

      await surface.evaluate(() => {
        const jump = document.querySelector(".sf-error-blocking button") as HTMLButtonElement | null;
        jump?.click();
      });
      await surface.waitForFunction(() => document.activeElement?.id === "ash-name", { timeout: 5_000 });
      const afterJump = await readSave(surface);
      expect(afterJump.inlineRefusals.join(" | "), "the jump must return to a still-explained field").toMatch(/name before saving/i);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("on step 3 with worktree still on, Save is in the nav, disabled, and still says why", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openPreview(page, server.origin, {
        query: { view: "agent-studio-shell", fixture: "new", ashStep: 3 },
        width: 880,
        waitFor: ".sf-region-fields",
      });
      const read = await readSave(surface);
      expect(read.headerSave.present).toBe(false);
      expect(read.navSave.present, "last step must carry Save").toBe(true);
      expect(read.navSave.disabled, "empty name and command must keep Save grey").toBe(true);
      expect(read.refusals.join(" | ")).toMatch(/name before saving/i);
      expect(read.refusals.join(" | ")).toMatch(/runtime command before saving/i);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("unchecking worktree does not light Save while name and command are still empty", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openPreview(page, server.origin, {
        query: { view: "agent-studio-shell", fixture: "new", ashStep: 2 },
        width: 880,
        waitFor: ".sf-region-fields",
      });
      await surface.evaluate(() => {
        const box = [...document.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes("own git worktree"))
          ?.querySelector("input") as HTMLInputElement | null;
        if (!box) throw new Error("worktree checkbox missing");
        if (box.checked) box.click();
      });
      await surface.evaluate(() => {
        const next = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith("Next"));
        (next as HTMLButtonElement | undefined)?.click();
      });
      await surface.waitForSelector(".ash-steps-nav", { timeout: 5_000 });
      const read = await readSave(surface);
      expect(read.navSave.present).toBe(true);
      expect(read.navSave.disabled, "toggling worktree must not enable an incomplete create").toBe(true);
      expect(read.refusals.join(" | ")).toMatch(/name before saving/i);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("filling name and command on step 3 enables Save with worktree still on", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openPreview(page, server.origin, {
        query: { view: "agent-studio-shell", fixture: "new", ashStep: 3 },
        width: 880,
        waitFor: ".sf-region-fields",
      });
      await surface.evaluate(() => {
        const name = document.querySelector("#ash-name") as HTMLInputElement | null;
        const cmd = document.querySelector("#ash-cmd") as HTMLInputElement | null;
        if (!name || !cmd) throw new Error("identity fields missing");
        name.value = "helper";
        name.dispatchEvent(new Event("input", { bubbles: true }));
        cmd.value = "claude";
        cmd.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 200));
      const read = await readSave(surface);
      expect(read.headerSave.present).toBe(false);
      expect(read.navSave.present).toBe(true);
      expect(read.navSave.disabled, "a named attested create must be saveable with worktree on").toBe(false);
      expect(read.refusals.join(" | ")).not.toMatch(/name before saving/i);
      expect(read.refusals.join(" | ")).not.toMatch(/runtime command before saving/i);
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);

  it("edit mode keeps Save in the header and has no create wizard nav", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openPreview(page, server.origin, {
        query: { view: "agent-studio-shell", fixture: "canonical-disabled" },
        width: 880,
        waitFor: ".sf-region-fields",
      });
      const read = await readSave(surface);
      expect(read.headerSave.present, "edit must keep header Save").toBe(true);
      expect(read.navSave.present).toBe(false);
      expect(read.headerButtons).toContain("Cancel");
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);
});
