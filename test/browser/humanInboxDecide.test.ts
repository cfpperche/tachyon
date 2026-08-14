import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import path from "node:path";
import * as esbuild from "esbuild";
import { resolveChromeExecutable } from "./support/chrome";
import { buildHumanInboxViewModel, buildHumanInboxItemViewModel } from "../../apps/vscode-extension/src/webview/human-inbox/viewModel.js";
import { buildSavedAgentProposalReview } from "../../apps/vscode-extension/src/agents/savedAgentProposalReview";

/**
 * t-58f9e9 point 4 — drive the REAL click, not an injected prop.
 *
 * Every other Human Inbox test renders statically: `test/helpers/staticPreact.ts` aliases
 * `preact/hooks` to a stub, because it has no DOM. That is the right tool for "does this component
 * show the error", and it is structurally unable to answer the question this task asks — whether
 * clicking Approve twice leaves the human with working buttons. Pending state, the effect that
 * clears it, and the disabled attribute that depends on both only exist while something is actually
 * mounted and re-rendering.
 *
 * So this file mounts `ItemApp` for real, inside the same headless Chrome the shots suite already
 * launches, and clicks it.
 *
 * The sequence is the one that shipped broken in 0.56.123 and was found while auditing that fix:
 * approve → refused → approve again → refused with the SAME reason. A repeated refusal is not an
 * edge case, it is what happens whenever the cause was not fixed between two attempts. The second
 * one used to leave Approve and Deny disabled forever, because the pending state was cleared by
 * watching the error STRING and `useState` bails out on an equal value — no re-render, no effect.
 *
 * Not part of `verify:full` (needs a system Chrome), same as the shots suite.
 */
const APPROVE = '[data-testid="inbox-approve-saved-agent"]';
const DENY = '[data-testid="inbox-deny-saved-agent"]';

/** Bundle ItemApp for the browser with REAL preact hooks, and expose a mount/update handle. */
async function bundleHarness(): Promise<string> {
  const entry = path.resolve(__dirname, "../../packages/webview-ui/src/webview/human-inbox/App.tsx");
  const built = await esbuild.build({
    stdin: {
      contents: `
        import { render, h } from "preact";
        import { ItemApp } from ${JSON.stringify(entry)};
        const root = document.getElementById("root");
        window.__decisions = [];
        const dispatch = {
          refresh() {}, open() {}, resolveApproval() {}, closeValidation() {}, assignValidation() {},
          decideSavedAgentProposal(id, digest, decision) { window.__decisions.push(decision); },
        };
        window.__render = (props) => render(h(ItemApp, { ...props, dispatch }), root);
      `,
      resolveDir: path.resolve(__dirname, "../.."),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "preact",
    write: false,
  });
  return built.outputFiles[0].text;
}

describe("Human Inbox — a repeated refusal must not disable the decision (t-58f9e9)", () => {
  let browser: Browser;
  let page: Page;
  let vm: unknown;

  beforeAll(async () => {
    const script = await bundleHarness();
    // Built through the REAL review projection, and opened through the REAL item view model, so the
    // buttons under test are the ones the projection actually enables.
    const proposal = buildSavedAgentProposalReview({
      proposal: {
        id: "sp-3efb66",
        proposer: "claude-runtime",
        proposerKind: "agent",
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        digest: "9f".repeat(32),
        base: { configSha256: "a".repeat(64) },
        spec: {
          name: "reviewer",
          runtimeAdapter: "claude",
          executable: "claude",
          rationale: "second reviewer for the release lane",
          permissionAuthorizations: ["bypassPermissions"],
        },
      } as never,
      currentConfigSha256: "a".repeat(64),
      nowMs: Date.parse("2026-08-01T01:00:00.000Z"),
    });
    vm = buildHumanInboxItemViewModel(
      buildHumanInboxViewModel({ folder: "tachyon", wsHash: "ws-1", approvals: [], validations: [], savedAgentProposals: [proposal] }),
      "saved-agent-proposal",
      "sp-3efb66",
    );

    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: script });
  }, 60_000);

  afterAll(async () => { await browser?.close(); });

  /**
   * Render, then let preact flush. `useEffect` is scheduled, not synchronous, and the state under
   * test is set INSIDE one — measuring before the flush would report the pre-effect frame and make
   * this test pass or fail on timing rather than on behaviour.
   */
  const paint = async (error?: { message: string }) => {
    await page.evaluate((props) => (window as never as { __render: (p: unknown) => void }).__render(props), { vm, error } as never);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const enabled = async (selector: string) =>
    page.$eval(selector, (el) => !(el as HTMLButtonElement).disabled);
  const decisions = async () =>
    page.evaluate(() => (window as never as { __decisions: string[] }).__decisions.length);

  it("re-enables Approve and Deny after a refusal, and again after an IDENTICAL one", async () => {
    await paint();
    // Deny is gated on a reason as well as on pending. Filling it first is what makes the Deny
    // assertions below measure the pending guard instead of the empty textarea.
    await page.type("textarea", "not authorized");
    expect(await enabled(APPROVE)).toBe(true);
    expect(await enabled(DENY)).toBe(true);

    // 1st attempt — the click must reach the host exactly once and hold the controls while in flight.
    await page.click(APPROVE);
    expect(await decisions()).toBe(1);
    expect(await enabled(APPROVE)).toBe(false);
    expect(await enabled(DENY)).toBe(false);

    // A second click while pending must not reach the host: that double-submit is what made the
    // human approve twice while the screen looked inert.
    await page.click(APPROVE, { force: true } as never).catch(() => undefined);
    expect(await decisions()).toBe(1);

    const refusal = { message: "agent-profile/authority-boundary: bypassPermissions is not authorized" };
    await paint(refusal);
    expect(await enabled(APPROVE)).toBe(true);
    await expect(page.$eval('[data-testid="inbox-saved-agent-error"]', (el) => el.textContent))
      .resolves.toContain("bypassPermissions is not authorized");

    // 2nd attempt, refused for the SAME reason. This is the regression: with the error carried as a
    // bare string, this receipt was indistinguishable from the previous one, nothing re-rendered, and
    // the controls stayed disabled until the human left the route.
    await page.click(APPROVE);
    expect(await decisions()).toBe(2);
    expect(await enabled(APPROVE)).toBe(false);

    await paint({ message: refusal.message });

    expect(await enabled(APPROVE)).toBe(true);
    expect(await enabled(DENY)).toBe(true);
    // And the decision still works after all that — a re-enabled button that dispatches nothing
    // would satisfy every assertion above and still be the dead button this task is about.
    await page.click(APPROVE);
    expect(await decisions()).toBe(3);
  });
});
