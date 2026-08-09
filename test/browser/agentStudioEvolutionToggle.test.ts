import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-f96b2f — the Agent Evolution toggle is REACHABLE, read off the shipped bundle's DOM.
 *
 * `Workspace.enableAgentSelfEvolution` was complete from t-d185e1 and had zero callers, because the
 * one control that would have called it was rendered `toggleDisabled={canonical}` with `canonical`
 * always true. Every other suite proves the bytes are written, the reference is pinned and the state
 * survives a save; none of them can prove a human can click the box. That claim only holds against
 * the rendered document, which is why it is asserted here.
 *
 * Measured at BOTH widths: `disabled` survives every layout, but a control that reflows out of view
 * at 360 reads as absent when it is merely off-screen — so the checked/disabled pair is read at each.
 *
 * Watched fail on the pre-fix tree at both widths: the toggle reported `disabled: true`.
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

interface ToggleState {
  toggle?: { disabled: boolean; checked: boolean };
  state: string;
}

const readToggle = (): ToggleState => {
  const element = document.querySelector(".ash-evolution-toggle input[type=checkbox]") as HTMLInputElement | null;
  return {
    toggle: element ? { disabled: element.disabled === true, checked: element.checked === true } : undefined,
    state: (document.querySelector(".ash-evolution-state")?.textContent || "").trim(),
  };
};

describe("t-f96b2f — Agent Studio can turn Agent Evolution on and off", () => {
  for (const width of [880, 360]) {
    it(`at ${width}px, an existing agent's toggle is usable and shows its real state`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: "agent-studio-shell", fixture: "canonical-disabled" },
          width,
          waitFor: ".ash-evolution",
        });
        const read = await surface.evaluate(readToggle);

        expect(read.toggle, "the Evolution toggle is missing from the shipped form").toBeDefined();
        expect(read.toggle!.disabled).toBe(false);
        // Checked, not merely enabled: this fixture's profile pins a selector, and a toggle that
        // rendered OFF for an evolving agent is the destructive shape — the next save turns the
        // capability off without anyone touching it.
        expect(read.toggle!.checked).toBe(true);
        expect(read.state).toBe("Enabled");
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);

    it(`at ${width}px, a NEW agent's toggle stays read-only until the profile exists`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        // t-547771 — `new`, the route a human opening New Agent actually gets. This case used to
        // borrow `new-unattested-runtime` because `new` was built on `blankAgentFields()` and
        // rendered a legacy form production cannot produce; the fixture carries the canonical shape
        // now, so the borrow is gone and the assertion is read off the real screen. The unattested
        // runtime was always beside the point here — what this case needs is a canonical form with
        // no profile behind it.
        const surface = await openPreview(page, server.origin, {
          query: { view: "agent-studio-shell", fixture: "new" },
          width,
          waitFor: ".ash-evolution",
        });
        const read = await surface.evaluate(readToggle);

        // The one case that stays disabled after this task, and for a stated reason rather than the
        // old blanket one: the selector pins a profile id the Evolution store mints for an agent that
        // already exists. The section says "Save agent first" for everything else it offers.
        expect(read.toggle!.disabled).toBe(true);
        expect(read.toggle!.checked).toBe(false);
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }
});
