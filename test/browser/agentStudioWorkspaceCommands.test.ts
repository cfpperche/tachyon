import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-afc86e — the verify gate and setup commands are EDITABLE, read off the shipped bundle's DOM.
 *
 * The unit and headless suites prove the bytes are written, read back and projected. Neither can
 * prove the human can reach them: the two controls existed the whole time and were rendered
 * `disabled={canonical}` — with `canonical` always true — under a hint promising a binding that no
 * task carried. A form that renders a control nobody can type into is exactly what this task was
 * filed for, so the assertion has to be made against the rendered document.
 *
 * Measured at BOTH widths: a field that reflows out of view at 360 reads as absent when it is only
 * off-screen, and `disabled` survives every layout.
 *
 * Watched fail on the pre-fix tree at both widths: both controls reported `disabled: true`, and the
 * read-only hint was in the document.
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

interface CommandFields {
  setup?: { disabled: boolean; value: string };
  verify?: { disabled: boolean; value: string };
  hints: string[];
}

const readFields = (): CommandFields => {
  const read = (id: string) => {
    const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    return element ? { disabled: element.disabled === true, value: element.value } : undefined;
  };
  return {
    setup: read("ash-setup"),
    verify: read("ash-verify"),
    hints: [...document.querySelectorAll(".sf-region-fields .hint")].map((hint) => (hint.textContent || "").trim()),
  };
};

describe("t-afc86e — Agent Studio can author a verify gate and setup commands", () => {
  for (const width of [880, 360]) {
    it(`at ${width}px, both controls are editable and show the profile's own values`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: "agent-studio-shell", fixture: "canonical-disabled" },
          width,
          waitFor: ".sf-region-fields",
        });
        const read = await surface.evaluate(readFields);

        expect(read.setup, "the setup control is missing from the shipped form").toBeDefined();
        expect(read.verify, "the verify control is missing from the shipped form").toBeDefined();
        expect(read.setup!.disabled).toBe(false);
        expect(read.verify!.disabled).toBe(false);
        // Populated, not merely enabled: an editable box that renders blank for an agent that HAS a
        // gate is the destructive shape — the next save writes the blank back over it.
        expect(read.verify!.value).toBe("npm run typecheck");
        expect(read.setup!.value).toBe("pnpm install\npnpm --filter web build");
        // The hint that promised a future binding is gone; the binding is what shipped instead.
        expect(read.hints.join(" | ")).not.toContain("remain read-only");
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);

    it(`at ${width}px, a workspace-published gate stays read-only and says who owns it`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: "agent-studio-shell", fixture: "foreign-workspace-commands" },
          width,
          waitFor: ".sf-region-fields",
        });
        const read = await surface.evaluate(readFields);

        expect(read.setup!.disabled).toBe(true);
        expect(read.verify!.disabled).toBe(true);
        // Read-only here is not the old permanent disablement: it is scoped to a value this Studio
        // did not publish, and the screen says so rather than promising a future binding.
        expect(read.hints.join(" | ")).toContain("published by the workspace");
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }
});
