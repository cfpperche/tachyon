import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * Agent Studio keeps setup authoring while the retired execution-verify control stays absent.
 *
 * The unit and headless suites prove the bytes are written, read back and projected. Neither can
 * prove the human can reach setup or that the removed control is absent from the shipped document,
 * so both assertions are made against the rendered bundle.
 *
 * Measured at BOTH widths so the narrow layout is covered too.
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
  retiredVerifyPresent: boolean;
  hints: string[];
}

const readFields = (): CommandFields => {
  const read = (id: string) => {
    const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    return element ? { disabled: element.disabled === true, value: element.value } : undefined;
  };
  return {
    setup: read("ash-setup"),
    retiredVerifyPresent: document.getElementById("ash-verify") !== null,
    hints: [...document.querySelectorAll(".sf-region-fields .hint")].map((hint) => (hint.textContent || "").trim()),
  };
};

describe("Agent Studio workspace commands", () => {
  for (const width of [880, 360]) {
    it(`at ${width}px, setup remains editable and execution verify is absent`, async () => {
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
        expect(read.setup!.disabled).toBe(false);
        expect(read.setup!.value).toBe("pnpm install\npnpm --filter web build");
        expect(read.retiredVerifyPresent).toBe(false);
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);

    it(`at ${width}px, workspace-published setup stays read-only and says who owns it`, async () => {
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
        expect(read.retiredVerifyPresent).toBe(false);
        expect(read.hints.join(" | ")).toContain("published by the workspace");
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }
});
