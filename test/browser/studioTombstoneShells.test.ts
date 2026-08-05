import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { STUDIO_PROTOCOL_VERSION } from "../../src/webview/shared/studio/protocol";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-b643ac — the tombstone reaches ALL FIVE single-mode studios, measured rather than assumed.
 *
 * The host fix lives in `SingleModeStudioPanelManager`, which command/terminal/runbook/schedule/agent
 * all extend — so "fix one, get five" is the claim, and the task says prove it rather than fix Agent
 * Studio and assume the rest. A source-level check would only prove five files contain similar text.
 * This drives the REAL shipped bundle for each shell through the dev preview harness: mount the edit
 * fixture (a live form, the state the maintainer photographed), post the `tombstone` envelope the host
 * now sends, and read what the DOM actually holds afterwards.
 *
 * Two assertions carry the fix, and both were watched FAIL on the pre-fix tree — where `tombstone` is
 * not a core message name at all, so the boundary decoder rejects it, the shell reports a protocol
 * error, and the form stays exactly where it was:
 *   - the form is GONE (`.sf-region-fields` absent), not merely covered by a banner;
 *   - there is no Save control anywhere in the document — decision 4's "impossible, not just ugly".
 */

const SHELLS = [
  { view: "command-studio-shell", entityType: "command", id: "verify" },
  { view: "terminal-studio-shell", entityType: "terminal", id: "shell" },
  { view: "runbook-studio-shell", entityType: "runbook", id: "release" },
  { view: "schedule-studio-shell", entityType: "schedule", id: "nightly" },
  { view: "agent-studio-shell", entityType: "agent", id: "grok" },
] as const;

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

/** What a human can see and click, read straight off the rendered document. */
interface Surface {
  hasForm: boolean;
  hasTombstone: boolean;
  /** every enabled OR disabled button label in the document — Save must not be among them. */
  buttonLabels: string[];
  tombstoneText: string;
}

async function readSurface(surface: Frame): Promise<Surface> {
  return surface.evaluate(() => ({
    hasForm: !!document.querySelector(".sf-region-fields"),
    hasTombstone: !!document.querySelector(".sf-tombstone-body"),
    buttonLabels: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
    tombstoneText: (document.querySelector(".sf-tombstone-body")?.textContent || "").replace(/\s+/g, " ").trim(),
  }));
}

describe("t-b643ac — a removed entity dematerializes every single-mode studio", () => {
  for (const shell of SHELLS) {
    it(`${shell.view}: replaces the form with a tombstone and leaves no Save`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        // The state the bug report is about: a fully mounted editor for an entity that still existed.
        const surface = await openPreview(page, server.origin, {
          query: { view: shell.view, fixture: "dense-edit" },
          waitFor: ".sf-region-fields",
        });
        const before = await readSurface(surface);
        expect(before.hasForm, `${shell.view}: fixture did not mount a form`).toBe(true);
        expect(before.buttonLabels).toContain("Save");

        await surface.evaluate(
          (entityType: string, entityId: string, protocolVersion: number) => {
            window.postMessage(
              {
                type: "tombstone",
                entityType,
                entityId,
                title: `${entityType} — ${entityId}`,
                discardedDraft: false,
                studioProtocolVersion: protocolVersion,
              },
              "*",
            );
          },
          shell.entityType,
          shell.id,
          STUDIO_PROTOCOL_VERSION,
        );
        await surface.waitForSelector(".sf-tombstone-body", { visible: true, timeout: 15_000 });

        const after = await readSurface(surface);
        // RED pre-fix: the decoder rejected an unknown type, so the form was still standing here.
        expect(after.hasForm, `${shell.view}: the form is still mounted over a removed entity`).toBe(false);
        expect(after.hasTombstone).toBe(true);
        // RED pre-fix: "Save" was still in this list, and clickable.
        expect(after.buttonLabels, `${shell.view}: Save survived on a removed entity`).not.toContain("Save");
        expect(after.buttonLabels).toEqual(["Close"]);
        expect(after.tombstoneText).toContain("No longer exists");
        expect(after.tombstoneText).toContain(shell.id);
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }

  it("says so when unsaved work was discarded, and stays quiet when there was none", async () => {
    const page = await browser.newPage();
    try {
      await page.bringToFront();
      const surface = await openPreview(page, server.origin, {
        query: { view: "agent-studio-shell", fixture: "dense-edit" },
        waitFor: ".sf-region-fields",
      });
      await surface.evaluate((protocolVersion: number) => {
        window.postMessage(
          { type: "tombstone", entityType: "agent", entityId: "grok", discardedDraft: true, studioProtocolVersion: protocolVersion },
          "*",
        );
      }, STUDIO_PROTOCOL_VERSION);
      await surface.waitForSelector(".sf-tombstone-draft", { visible: true, timeout: 15_000 });

      const text = await surface.evaluate(() => (document.querySelector(".sf-tombstone-draft")?.textContent || "").trim());
      expect(text).toContain("unsaved changes were discarded");
    } finally {
      await page.close();
    }
  }, HANG_TIMEOUT_MS);
});
