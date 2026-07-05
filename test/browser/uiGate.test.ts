import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// spec 342 T3 — THE COMPAT GATE. Per spec.md's checklist, browser-level (not jsdom): open/close, Esc,
// outside-click dismissal, Tab/Shift+Tab containment where applicable, focus restore, nested portals,
// keyboard nav/typeahead, aria-expanded/aria-controls/id stability. Pass/fail per component is transcribed
// into docs/specs/342-vendored-ui-components/notes.md — THIS file is the evidence, not the record.
//
// Tooltip and Dialog GATE FAILURES are captured with vitest's `.fails` modifier, NOT skipped or deleted:
// the suite stays green (a failing modifier that starts passing is itself a signal — Radix shipped a fix,
// re-gate), while the actual repro stays live and runnable. See notes.md for the full disposition.
describe("ui-gate compat gate (T3)", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await page.goto(server.url, { waitUntil: "networkidle0" });
  });

  afterEach(async () => {
    await page.close();
  });

  const activeTestId = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? null);
  const isInBodyOutsideRoot = (p: Page, selector: string) =>
    p.evaluate((sel) => {
      const el = document.querySelector(sel);
      const root = document.getElementById("root");
      return !!el && !!root && !root.contains(el);
    }, selector);
  // Radix's open/focus transitions run a tick after the triggering event (state machine + rAF); polling for
  // the expected activeElement (instead of a fixed sleep) is what makes these checks non-flaky WITHOUT
  // silently forgiving a real timing regression — a component that never reaches the expected state still
  // times out and fails.
  const waitForActiveTestId = (p: Page, testId: string, timeout = 2000) =>
    p.waitForFunction((id) => document.activeElement?.getAttribute("data-testid") === id, { timeout }, testId);

  describe("Tooltip — GATE FAILURE (excluded; T4 ships no KitTooltip)", () => {
    // Repro: neither a real mouse hover NOR a programmatic focus opens the tooltip under preact/compat, even
    // waiting a full second (well past TooltipProvider's delayDuration=0). `data-state` stays "closed" and
    // `[data-testid="tooltip-content"]` never mounts. Verified with both trigger mechanisms manually before
    // encoding as a permanent `.fails` regression probe.
    it.fails("opens on trigger focus, restoring focus on Escape close", async () => {
      await page.focus('[data-testid="tooltip-trigger"]');
      await page.waitForSelector('[data-testid="tooltip-content"]', { visible: true, timeout: 1000 });
      expect(await activeTestId(page)).toBe("tooltip-trigger");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="tooltip-content"]', { hidden: true, timeout: 1000 });
    });

    it.fails("keeps aria-describedby on the trigger pointed at the content's id", async () => {
      await page.focus('[data-testid="tooltip-trigger"]');
      await page.waitForSelector('[data-testid="tooltip-content"]', { visible: true, timeout: 1000 });
      const linked = await page.evaluate(() => {
        const trigger = document.querySelector('[data-testid="tooltip-trigger"]');
        const content = document.querySelector('[data-testid="tooltip-content"]');
        const describedBy = trigger?.getAttribute("aria-describedby");
        return !!describedBy && describedBy === content?.id;
      });
      expect(linked).toBe(true);
    });
  });

  describe("DropdownMenu — GATE PASS", () => {
    it("opens on click, exposes aria-expanded + aria-controls matching the content id", async () => {
      await page.click('[data-testid="dropdown-trigger"]');
      await page.waitForSelector('[data-testid="dropdown-content"]', { visible: true, timeout: 2000 });
      const linked = await page.evaluate(() => {
        const trigger = document.querySelector('[data-testid="dropdown-trigger"]');
        const content = document.querySelector('[data-testid="dropdown-content"]');
        const controls = trigger?.getAttribute("aria-controls");
        return trigger?.getAttribute("aria-expanded") === "true" && !!controls && controls === content?.id;
      });
      expect(linked).toBe(true);
    });

    it("supports ArrowDown roving focus between items (keyboard nav)", async () => {
      await page.click('[data-testid="dropdown-trigger"]');
      await page.waitForSelector('[data-testid="dropdown-content"]', { visible: true, timeout: 2000 });
      await waitForActiveTestId(page, "dropdown-content"); // initial focus lands on the content wrapper
      await page.keyboard.press("ArrowDown");
      await waitForActiveTestId(page, "dropdown-item-alpha");
      await page.keyboard.press("ArrowDown");
      await waitForActiveTestId(page, "dropdown-item-bravo");
    });

    it("closes on Escape and restores focus to the trigger", async () => {
      await page.click('[data-testid="dropdown-trigger"]');
      await page.waitForSelector('[data-testid="dropdown-content"]', { visible: true, timeout: 2000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="dropdown-content"]', { hidden: true, timeout: 2000 });
      await waitForActiveTestId(page, "dropdown-trigger");
    });

    it("dismisses on outside click", async () => {
      await page.click('[data-testid="dropdown-trigger"]');
      await page.waitForSelector('[data-testid="dropdown-content"]', { visible: true, timeout: 2000 });
      await page.mouse.click(5, 5);
      await page.waitForSelector('[data-testid="dropdown-content"]', { hidden: true, timeout: 2000 });
    });

    it("renders its content via a portal outside #root (nested-portal check)", async () => {
      await page.click('[data-testid="dropdown-trigger"]');
      await page.waitForSelector('[data-testid="dropdown-content"]', { visible: true, timeout: 2000 });
      expect(await isInBodyOutsideRoot(page, '[data-testid="dropdown-content"]')).toBe(true);
    });

    // dogfood round 1 (#1, CRITICAL) — gate parity for the KitDropdown-opens-nothing-in-the-real-webview
    // finding. Production's only shipped consumer (Plugins card actions) uses `asChild` over an IconButton
    // and renders N instances on one page (one per card) — neither shape was exercised above. This can't
    // reproduce the Electron-webview-specific failure itself (see notes.md's root-cause writeup: nested
    // iframe, RO/IO-neutered, and cross-origin sandboxed iframe reproduction attempts all failed in headless
    // Chrome — same as this gate), but it closes real structural coverage gaps and proves the content is
    // genuinely POSITIONED on screen (not just aria-correct), which `updatePositionStrategy="always"` fixes.
    it("an asChild/IconButton trigger opens with its content positioned within the viewport (not off-screen)", async () => {
      // the gate page is taller than the default 800x600 viewport; a short viewport makes Radix's OWN
      // collision-avoidance flip the content off-screen, which would be a fixture artifact, not the bug
      // under test — a tall viewport isolates "is it positioned at all" from "did it fit."
      await page.setViewport({ width: 1024, height: 1400 });
      await page.click('[data-testid="kit-dropdown-card-trigger-a"]');
      await page.waitForSelector('[data-testid="kit-dropdown-card-content-a"]', { visible: true, timeout: 2000 });
      const rect = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="kit-dropdown-card-content-a"]');
        const r = el!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeLessThan(await page.evaluate(() => window.innerHeight));
      // functional proof, not just a position read: a real click at the item's rendered coordinates must
      // actually select it (matches this repo's existing "functional, not just visual" testing convention).
      await page.click('[data-testid="kit-dropdown-card-item-a"]');
      await page.waitForSelector('[data-testid="kit-dropdown-card-content-a"]', { hidden: true, timeout: 2000 });
    });

    it("opening a second KitDropdown instance after closing the first works (multi-instance, real clicks)", async () => {
      await page.click('[data-testid="kit-dropdown-card-trigger-a"]');
      await page.waitForSelector('[data-testid="kit-dropdown-card-content-a"]', { visible: true, timeout: 2000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="kit-dropdown-card-content-a"]', { hidden: true, timeout: 2000 });

      await page.click('[data-testid="kit-dropdown-card-trigger-b"]');
      await page.waitForSelector('[data-testid="kit-dropdown-card-content-b"]', { visible: true, timeout: 2000 });
      const expanded = await page.evaluate(() => document.querySelector('[data-testid="kit-dropdown-card-trigger-b"]')?.getAttribute("aria-expanded"));
      expect(expanded).toBe("true");
    });
  });

  describe("Select — GATE PASS", () => {
    it("opens on click, selects via keyboard (typeahead + Enter), and updates the trigger value", async () => {
      await page.click('[data-testid="select-trigger"]');
      await page.waitForSelector('[data-testid="select-content"]', { visible: true, timeout: 2000 });
      await waitForActiveTestId(page, "select-item-alpha"); // the current value's item is focused on open
      await page.keyboard.type("b"); // typeahead → jumps to "Bravo"
      await waitForActiveTestId(page, "select-item-bravo");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="select-content"]', { hidden: true, timeout: 2000 });
      const label = await page.$eval('[data-testid="select-trigger"]', (el) => el.textContent);
      expect(label).toContain("Bravo");
    });

    it("closes on Escape and restores focus to the trigger", async () => {
      await page.click('[data-testid="select-trigger"]');
      await page.waitForSelector('[data-testid="select-content"]', { visible: true, timeout: 2000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="select-content"]', { hidden: true, timeout: 2000 });
      await waitForActiveTestId(page, "select-trigger");
    });

    it("exposes aria-expanded + aria-controls matching the content id", async () => {
      await page.click('[data-testid="select-trigger"]');
      await page.waitForSelector('[data-testid="select-content"]', { visible: true, timeout: 2000 });
      const linked = await page.evaluate(() => {
        const trigger = document.querySelector('[data-testid="select-trigger"]');
        const content = document.querySelector('[data-testid="select-content"]');
        const controls = trigger?.getAttribute("aria-controls");
        return trigger?.getAttribute("aria-expanded") === "true" && !!controls && controls === content?.id;
      });
      expect(linked).toBe(true);
    });

    it("opens with popper positioning and no phantom scroll chevron chrome", async () => {
      await page.click('[data-testid="kit-select-trigger"]');
      await page.waitForSelector('[data-slot="select-content"]', { visible: true, timeout: 2000 });
      const state = await page.evaluate(() => {
        const trigger = document.querySelector('[data-testid="kit-select-trigger"]') as HTMLElement | null;
        const content = document.querySelector('[data-slot="select-content"]') as HTMLElement | null;
        const triggerRect = trigger?.getBoundingClientRect();
        const contentRect = content?.getBoundingClientRect();
        return {
          hasScrollChrome: !!document.querySelector('[data-slot="select-scroll-up-button"], [data-slot="select-scroll-down-button"]'),
          belowTrigger: !!triggerRect && !!contentRect && contentRect.top >= triggerRect.bottom - 1,
          widthCoversTrigger: !!triggerRect && !!contentRect && contentRect.width >= triggerRect.width - 1,
        };
      });
      expect(state.hasScrollChrome).toBe(false);
      expect(state.belowTrigger).toBe(true);
      expect(state.widthCoversTrigger).toBe(true);
    });
  });

  describe("Popover — GATE PASS", () => {
    it("opens on click, auto-focusing the first focusable field in its content", async () => {
      await page.click('[data-testid="popover-trigger"]');
      await page.waitForSelector('[data-testid="popover-content"]', { visible: true, timeout: 2000 });
      await waitForActiveTestId(page, "popover-input");
    });

    it("closes on Escape and restores focus to the trigger", async () => {
      await page.click('[data-testid="popover-trigger"]');
      await page.waitForSelector('[data-testid="popover-content"]', { visible: true, timeout: 2000 });
      await waitForActiveTestId(page, "popover-input");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="popover-content"]', { hidden: true, timeout: 2000 });
      await waitForActiveTestId(page, "popover-trigger");
    });

    it("dismisses on outside click", async () => {
      await page.click('[data-testid="popover-trigger"]');
      await page.waitForSelector('[data-testid="popover-content"]', { visible: true, timeout: 2000 });
      await page.mouse.click(5, 5);
      await page.waitForSelector('[data-testid="popover-content"]', { hidden: true, timeout: 2000 });
    });

    it("renders its content via a portal outside #root (nested-portal check)", async () => {
      await page.click('[data-testid="popover-trigger"]');
      await page.waitForSelector('[data-testid="popover-content"]', { visible: true, timeout: 2000 });
      expect(await isInBodyOutsideRoot(page, '[data-testid="popover-content"]')).toBe(true);
    });
  });

  describe("Dialog — GATE FAILURE (excluded; no legacy modal to fall back to, so T6 ships no KitDialog)", () => {
    // Repro: clicking the trigger opens (aria-expanded=true, data-state=open on the trigger, the Overlay
    // mounts), then an UNCAUGHT exception fires before Content mounts: `TypeError: Failed to execute
    // 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.` — some ref Radix Dialog's
    // internals (RemoveScroll/FocusScope) expects to be attached by the time it reads computed style isn't,
    // under preact/compat's ref-forwarding timing. `[data-testid="dialog-content"]` never mounts.
    it.fails("opens without an uncaught exception", async () => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(String(err)));
      await page.click('[data-testid="dialog-trigger"]');
      await page.waitForSelector('[data-testid="dialog-content"]', { visible: true, timeout: 1000 });
      expect(pageErrors).toEqual([]);
    });

    it.fails("traps Tab within the modal (last → first wraps forward)", async () => {
      await page.click('[data-testid="dialog-trigger"]');
      await page.waitForSelector('[data-testid="dialog-content"]', { visible: true, timeout: 1000 });
      await page.focus('[data-testid="dialog-close-footer"]');
      await page.keyboard.press("Tab");
      const stillInDialog = await page.evaluate(() => {
        const content = document.querySelector('[data-testid="dialog-content"]');
        return !!content && content.contains(document.activeElement);
      });
      expect(stillInDialog).toBe(true);
    });

    it.fails("closes on Escape and restores focus to the trigger", async () => {
      await page.click('[data-testid="dialog-trigger"]');
      await page.waitForSelector('[data-testid="dialog-content"]', { visible: true, timeout: 1000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="dialog-content"]', { hidden: true, timeout: 1000 });
      await waitForActiveTestId(page, "dialog-trigger", 1000);
    });

    it.fails("dismisses on outside click (clicking the overlay)", async () => {
      await page.click('[data-testid="dialog-trigger"]');
      await page.waitForSelector('[data-testid="dialog-content"]', { visible: true, timeout: 1000 });
      await page.mouse.click(5, 5);
      await page.waitForSelector('[data-testid="dialog-content"]', { hidden: true, timeout: 1000 });
    });
  });

  it("loads the gate page itself with no console/response errors", async () => {
    const pageErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("response", (res) => {
      if (!res.ok() && !res.url().endsWith("/favicon.ico")) failedResponses.push(`${res.status()} ${res.url()}`);
    });
    const response = await page.goto(server.url, { waitUntil: "networkidle0" });
    expect(response?.ok()).toBe(true);
    expect(failedResponses).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
