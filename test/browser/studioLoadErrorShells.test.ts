import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";
import { agentStudioShellFixtures } from "../../scripts/webview-preview/fixtures/agent-studio-shell";
import { commandStudioShellFixtures } from "../../scripts/webview-preview/fixtures/command-studio-shell";
import { runbookStudioShellFixtures } from "../../scripts/webview-preview/fixtures/runbook-studio-shell";
import { scheduleStudioShellFixtures } from "../../scripts/webview-preview/fixtures/schedule-studio-shell";
import { terminalStudioShellFixtures } from "../../scripts/webview-preview/fixtures/terminal-studio-shell";
import { pipelineStudioFixtures } from "../../scripts/webview-preview/fixtures/pipeline-studio";
import { studioLoadErrorTitle } from "@tachyon/webview-ui/webview/shared/studio/studioLoadErrorTitle";

/**
 * t-f4e186 — an `error` envelope that arrives with NO prior `load` must not leave the surface
 * claiming it is still loading.
 *
 * The property, not the wording. A test that looked for "Loading Agent Studio…" would pass green the
 * day someone rewords the spinner, and it would say nothing about the six other studios that hold the
 * same guard. So each assertion below is keyed on something the test itself supplied or on structure:
 *
 *   - the message THIS fixture put on the wire is readable in the document (the error reached a human);
 *   - `.ds-degrade` — the shared loading surface every shell renders — is gone.
 *
 * Both were watched FAIL on the pre-fix tree for all five single-mode studios: the shells return their
 * loading screen from `if (!ready || !entity)`, and an `error` sets `ready` without ever setting
 * `entity`, so the spinner is the terminal state and the error has no path to the screen.
 *
 * `pipeline-studio` is in the list as the CONTROL, and it was green before the fix as well as after:
 * its guard is `if (!ready)` alone, so the same envelope already reached StudioFrame's `loadFailed`
 * banner. It is the measurement that says the fix restores an existing contract rather than inventing
 * one — and it fails here if that contract is ever lost.
 *
 * Task Studio and Pin Studio hold the identical guard (TaskDetailPanel.ts / PinDetailPanel.ts post the
 * same bare `error`), and take the same fix; they are absent here only because the preview catalog has
 * no `load-error` route for either — see t-f4e186's journal.
 *
 * ## t-831332 — no entity claim, no dead Save
 *
 * An error envelope carries no identity. The screen must not invent one (titleFor's "New …" path)
 * and must not offer Save when there is no subject. Assertions are structural and fixture-supplied:
 *
 *   - title equals `studioLoadErrorTitle(entityType)` — the surface the shell knows it is;
 *   - button labels do not include Save (absent, not merely disabled — same as t-b643ac's tombstone).
 *
 * A string search for "New Agent" would go green the day someone rewords the create-flow title; these
 * do not.
 */

interface ShellUnderTest {
  view: string;
  /** the exact text the fixture puts on the wire — the assertion is "this reached the screen". */
  message: string;
  /** the studio kind the shell already knows — used to derive the only honest load-error title. */
  entityType: string;
}

function loadErrorMessage(fixtures: Record<string, { vm: unknown }>, view: string): string {
  const vm = fixtures["load-error"]?.vm as { loadError?: { message?: string } } | undefined;
  const message = vm?.loadError?.message;
  if (!message) throw new Error(`${view}: the preview catalog has no load-error fixture to measure`);
  return message;
}

const SHELLS: ShellUnderTest[] = [
  { view: "agent-studio-shell", entityType: "agent", message: loadErrorMessage(agentStudioShellFixtures, "agent-studio-shell") },
  { view: "command-studio-shell", entityType: "command", message: loadErrorMessage(commandStudioShellFixtures, "command-studio-shell") },
  { view: "runbook-studio-shell", entityType: "runbook", message: loadErrorMessage(runbookStudioShellFixtures, "runbook-studio-shell") },
  { view: "schedule-studio-shell", entityType: "schedule", message: loadErrorMessage(scheduleStudioShellFixtures, "schedule-studio-shell") },
  { view: "terminal-studio-shell", entityType: "terminal", message: loadErrorMessage(terminalStudioShellFixtures, "terminal-studio-shell") },
  { view: "pipeline-studio", entityType: "pipeline", message: loadErrorMessage(pipelineStudioFixtures, "pipeline-studio") },
];

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

/** What a human can see, read straight off the rendered document. */
interface Surface {
  /** the shared loading surface — present means the shell still says "still loading". */
  stillLoading: boolean;
  /** StudioFrame's load-failure banner, the one this defect kept unreachable. */
  hasLoadErrorBanner: boolean;
  text: string;
  title: string;
  /** every enabled OR disabled button label — Save must not be among them after t-831332. */
  buttonLabels: string[];
}

async function readSurface(surface: Frame): Promise<Surface> {
  return surface.evaluate(() => ({
    stillLoading: !!document.querySelector(".ds-degrade"),
    hasLoadErrorBanner: !!document.querySelector(".sf-banner-error"),
    text: (document.body.innerText || "").replace(/\s+/g, " ").trim(),
    title: (document.querySelector(".sf-title")?.textContent || "").trim(),
    buttonLabels: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
  }));
}

describe("t-f4e186 — an error answer never leaves a studio in the loading state", () => {
  for (const shell of SHELLS) {
    it(`${shell.view}: shows the failure instead of loading forever`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: shell.view, fixture: "load-error" },
        });
        // Bounded, and deliberately not a hard wait: on the pre-fix tree nothing ever arrives, so the
        // run must reach the assertions and report WHAT the surface held rather than dying on a
        // selector timeout that says only "not found".
        await surface.waitForSelector(".sf-banner-error", { visible: true, timeout: 8_000 }).catch(() => undefined);

        const after = await readSurface(surface);
        // RED pre-fix (all five single-mode shells): the spinner was the terminal state.
        expect(after.stillLoading, `${shell.view}: still on the loading surface after an error answer`).toBe(false);
        expect(after.hasLoadErrorBanner, `${shell.view}: no load-failure banner`).toBe(true);
        // RED pre-fix: the host's own sentence never reached the document.
        expect(after.text, `${shell.view}: the delivered error text is not on screen`).toContain(shell.message);
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }
});

describe("t-831332 — a load-error screen claims only the surface and offers no dead Save", () => {
  for (const shell of SHELLS) {
    it(`${shell.view}: titles the surface and leaves Save out of the tree`, async () => {
      const page = await browser.newPage();
      try {
        await page.bringToFront();
        const surface = await openPreview(page, server.origin, {
          query: { view: shell.view, fixture: "load-error" },
        });
        await surface.waitForSelector(".sf-banner-error", { visible: true, timeout: 8_000 }).catch(() => undefined);

        const after = await readSurface(surface);
        // Positive: the title is exactly what the screen knows (which studio), computed the same way
        // production computes it — not a create-flow label and not a fabricated entity id.
        expect(after.title, `${shell.view}: title must name the surface, not an entity`).toBe(
          studioLoadErrorTitle(shell.entityType),
        );
        // Positive structural: Save is absent. A disabled Save still appears in this list (pre-fix).
        expect(after.buttonLabels, `${shell.view}: Save survived on a document with no subject`).not.toContain("Save");
        expect(after.buttonLabels).toContain("Cancel");
      } finally {
        await page.close();
      }
    }, HANG_TIMEOUT_MS);
  }
});
