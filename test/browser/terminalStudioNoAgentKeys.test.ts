import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";
import { TERMINAL_STRIPPED_AGENT_KEYS } from "../../src/config/YamlConfigEditor";

/**
 * t-b54ead — what the Terminal Studio OFFERS, read off the shipped bundle's DOM.
 *
 * The unit suite proves the write path cannot emit a key the loader refuses for a terminal. It cannot
 * prove the form stopped asking for one: a control can exist, be filled, be dirty, and be silently
 * dropped downstream, which is a worse screen than the one this task removed. Only the rendered
 * document answers that, so this mounts the real `terminal-studio-shell` bundle through the preview
 * harness and enumerates every control and every visible heading in it.
 *
 * Measured at BOTH of this repo's widths: a `<details>` section that collapses at 360 would otherwise
 * read as "absent" when it is merely closed.
 *
 * Watched fail on the pre-fix tree at both widths: `controlIds` held tsh-branch / tsh-setup / tsh-verify
 * and `headings` held "Git worktree isolation".
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

/** Every editable control in the document, by whatever a future author would key it on. */
interface FormSurface {
  controlIds: string[];
  labels: string[];
  headings: string[];
  controlCount: number;
}

describe("t-b54ead — Terminal Studio offers no control for an agent-only key", () => {
  for (const width of [880, 360]) {
    it(`at ${width}px, no worktree/verify control is reachable`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: "terminal-studio-shell", fixture: "dense-edit" },
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
        expect(read.headings).not.toContain("Git worktree isolation");
        const haystack = [...read.controlIds, ...read.labels, ...read.headings].join(" | ").toLowerCase();
        for (const key of TERMINAL_STRIPPED_AGENT_KEYS) {
          // `kind` is implied by the studio and never a control; the rest must not appear at all.
          if (key === "kind") continue;
          expect(haystack, `Terminal Studio surfaces '${key}', which the loader refuses for a terminal`).not.toContain(key.toLowerCase());
        }
        // The controls a terminal legitimately has are still there — this is not passing by rendering nothing.
        expect(read.controlIds).toEqual(expect.arrayContaining(["tsh-name", "tsh-cmd", "tsh-cwd", "tsh-watch"]));
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }
});
