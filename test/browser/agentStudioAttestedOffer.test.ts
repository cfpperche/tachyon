import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";
import { ATTESTED_RUNTIMES } from "@tachyon/shared/runtime/attestedRuntimes";

/**
 * t-d68b8b — what the Agent form OFFERS and what it SAYS when it refuses, read off the shipped
 * bundle's DOM.
 *
 * The unit suite proves `quickAddChips` filters and that every creation door refuses. Neither can
 * prove the human sees it: a chip can exist, be clicked, fill the form and only fail at Save — which
 * is precisely the dead end this task reports, and the reason a form fix has to be measured on the
 * rendered document rather than on the function behind it.
 *
 * Measured at BOTH of this repo's widths (880 and 360). A refusal banner that only fits at 880, or a
 * chip row that reflows into a scroller at 360, reads as present in one and absent in the other.
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

describe("t-d68b8b — the Agent form offers only what it can create", () => {
  for (const width of [880, 360]) {
    it(`at ${width}px, every Quick Add chip names an attested runtime`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: "agent-studio-shell", fixture: "new-unattested-runtime" },
          width,
          waitFor: ".sf-region-fields",
        });
        const chips: string[] = await surface.evaluate(() =>
          [...document.querySelectorAll('[aria-label="Quick add"] .ds-chip, [aria-label="Quick add"] button')]
            .map((chip) => (chip.textContent || "").trim())
            .filter(Boolean));

        expect(chips.length, "the fixture did not mount a chip row").toBeGreaterThan(0);
        // What this does and does not prove: `entity.chips` arrives from the HOST, so the filter
        // itself is measured in `test/unit/agentStudioAttestedCreation.test.ts`, not here. What the
        // rendered document answers is whether the offer a human can see is limited to runtimes this
        // form can create — which is why the preview fixture derives its row from ATTESTED_RUNTIMES
        // too. Watched fail at both widths on the pre-fix fixture: 'Antigravity CLI' and 'Gemini CLI
        // (legacy)' rendered as clickable offers.
        for (const chip of chips) {
          const named = ATTESTED_RUNTIMES.filter((runtime) => chip.toLowerCase().includes(runtime));
          expect(named.length, `chip '${chip}' names no attested runtime`).toBeGreaterThan(0);
        }
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);

    it(`at ${width}px, typing an unattested runtime blocks Save and says why`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: "agent-studio-shell", fixture: "new-unattested-runtime" },
          width,
          waitFor: ".sf-region-fields",
        });
        const read: { refusals: string[]; saveDisabled: boolean | null } = await surface.evaluate(() => {
          const save = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Save");
          return {
            refusals: [...document.querySelectorAll(".sf-error-blocking")].map((e) => (e.textContent || "").trim()),
            saveDisabled: save ? save.disabled : null,
          };
        });

        expect(read.saveDisabled, "no Save button in the shipped frame").toBe(true);
        const refusal = read.refusals.join(" | ");
        expect(refusal).toContain("opencode");
        expect(refusal).toContain(ATTESTED_RUNTIMES.join(", "));
        // The task's whole complaint was the wording: the old path sent the human to Agent Studio
        // from inside Agent Studio. The replacement has to name the creation path as the limit and
        // say the block lifts — not imply the runtime is unfit, and not point anywhere circular.
        expect(refusal).toContain("creation path");
        expect(refusal).toContain("not a verdict on the runtime");
        expect(refusal.toLowerCase()).not.toContain("agent studio");
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }
});
