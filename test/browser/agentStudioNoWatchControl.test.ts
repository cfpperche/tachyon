import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-bd14d8 — what the Agent form OFFERS, read off the shipped bundle's DOM.
 *
 * The unit suite proves no Agent authoring door writes a `watch`. It cannot prove the form stopped
 * ASKING for one: a control can exist, be filled, be dirty, and be dropped downstream, which is a
 * worse screen than the one this task removed. Only the rendered document answers that.
 *
 * Measured at BOTH of this repo's widths — a control that reflows out of view at 360 reads as absent
 * when it is merely off-screen, and one inside a collapsed `<details>` is still an offer.
 *
 * The mirror case for the Terminal form lives in `terminalStudioNoAgentKeys.test.ts`, which asserts
 * `tsh-watch` is PRESENT. The two together are the boundary: the capability moved, it did not vanish.
 *
 * Watched fail on the pre-fix tree at both widths: `ash-watch` was in `controlIds` and "Watch
 * patterns" in `labels`.
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

interface FormSurface {
  controlIds: string[];
  labels: string[];
  headings: string[];
  controlCount: number;
}

describe("t-bd14d8 — Agent Studio offers no watch control", () => {
  for (const width of [880, 360]) {
    it(`at ${width}px, no watch control is reachable in the agent form`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: "agent-studio-shell", fixture: "canonical-disabled" },
          width,
          waitFor: ".sf-region-fields",
        });
        const read: FormSurface = await surface.evaluate(() => {
          const controls = [...document.querySelectorAll<HTMLElement>(".sf-region-fields input, .sf-region-fields textarea, .sf-region-fields select")];
          return {
            controlIds: controls.map((c) => c.id).filter(Boolean),
            labels: [...document.querySelectorAll(".sf-region-fields label")].map((l) => (l.textContent || "").trim()),
            // `summary` included on purpose: a collapsed <details> is still an offer.
            headings: [...document.querySelectorAll(".sf-region-fields summary, .sf-region-fields h1, .sf-region-fields h2, .sf-region-fields h3")].map((h) => (h.textContent || "").trim()),
            controlCount: controls.length,
          };
        });

        expect(read.controlCount, "the fixture did not mount a populated form").toBeGreaterThan(0);
        expect(read.controlIds).not.toContain("ash-watch");
        const haystack = [...read.controlIds, ...read.labels, ...read.headings].join(" | ").toLowerCase();
        expect(haystack, "Agent Studio surfaces a watch control, which is a Terminal capability").not.toContain("watch");
        // Not passing by rendering nothing: the lifecycle controls this form legitimately has are here.
        expect(read.controlIds).toEqual(expect.arrayContaining(["ash-name", "ash-cmd", "ash-cwd"]));
        expect(read.labels.join(" | ")).toContain("Auto-start");
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }
});
