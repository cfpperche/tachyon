import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { buildHumanInboxViewModel, buildHumanInboxItemViewModel } from "../../src/webview/human-inbox/viewModel.js";
import { assembleUntrustedSrcdoc } from "../../src/webview/shared/untrustedSrcdoc.js";
import type { ApprovalViewItem } from "../../src/webview/approval/viewModel.js";
import type { ValidationViewItem } from "../../src/webview/validations/viewModel.js";
import { buildSavedAgentProposalReview } from "../../src/agents/savedAgentProposalReview.js";
import type { SavedAgentProposalReview } from "../../src/agents/savedAgentProposalReview.js";

/**
 * Human Inbox — headless Visual QA for the states the task enumerates (t-e76acc).
 *
 * The unit suite proves what the detail route KNOWS about an artifact. What it cannot prove is the
 * thing the task actually asks for — that the evidence is legible, and that a 3000px screenshot or a
 * long branch name does not turn a narrow Control panel into a horizontally-scrolling page. That is a
 * layout property, so it is measured in a real browser against the real, shipped stylesheets.
 *
 * Two outputs, both deliberate:
 *  - PNGs a human can look at (.tachyon/visual-qa/e76acc-human-inbox), because "no artifacts" vs "one
 *    image" vs "unavailable" is a judgement about appearance;
 *  - a MECHANICAL overflow assertion per shot, because "looks fine to me" is not evidence and a
 *    reviewer scrolling a screenshot cannot see a page that scrolls sideways.
 *
 * Not part of `verify:full` (needs a system Chrome and a built `dist/`). Regenerate with:
 *
 *     npm run build && npx vitest run --config vitest.browser.config.ts test/browser/humanInboxShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/e76acc-human-inbox");
const DIST = path.resolve(__dirname, "../../dist/webview");
/** Control's comfortable width, and the narrowest a person plausibly drags the panel to. */
const WIDTHS = [
  { id: "880", px: 880 },
  { id: "narrow-360", px: 360 },
];

/** A 1×1 PNG, inlined the same way the host inlines a real screenshot. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** A WIDE image: the case that breaks a page's layout if the stylesheet does not cap it. */
const WIDE_PNG =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="600"><rect width="2400" height="600" fill="#264f78"/><text x="60" y="330" font-size="120" fill="#fff">2400px wide evidence</text></svg>`,
  ).toString("base64");

/**
 * Ages are RELATIVE, and that is what makes these artifacts durable.
 *
 * The card renders "how long has this waited" against the real clock, so fixed fixture dates make
 * every regeneration differ from the last — the first re-run after landing changed 14 of 17 PNGs by
 * exactly one hour. A screenshot set that churns hourly cannot answer "did the UI change?", which is
 * the only question it exists to answer. Anchoring the fixtures to `now` pins the rendered text
 * ("40h", "3d") instead of the timestamp behind it.
 */
const hoursAgo = (h: number): string => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

const approval = (id: string, over: Partial<ApprovalViewItem> = {}): ApprovalViewItem => ({
  id,
  requester: "codex-canonico",
  session: "tachyon-ws-codex",
  createdAt: hoursAgo(40),
  payload: {
    reason: "reconcile_base needs a human before it rewrites the delivery's base",
    proposedAction: "git-delivery reconcile_base d-4f1a2b onto main@2577d527",
    risk: "rewrites a shared ref; not reversible from inside Tachyon",
    exactPrompt: "May I reconcile d-4f1a2b onto the new base?",
  },
  tampered: false,
  ...over,
});

const validation = (id: string, over: Partial<ValidationViewItem> = {}): ValidationViewItem => ({
  id,
  title: "Dogfood the unified inbox in a real VS Code window",
  status: "pending",
  executor: "human",
  type: "dogfood",
  priority: 1,
  instructions: "Open Control → Inbox, work one approval and one validation, and attach what you saw.",
  sourceRefs: [],
  rounds: [],
  createdAt: hoursAgo(15),
  updatedAt: hoursAgo(15),
  ...over,
});

const vmOf = (
  approvals: ApprovalViewItem[],
  validations: ValidationViewItem[],
  savedAgentProposals: SavedAgentProposalReview[] = [],
) =>
  // no explicit `now`: staleness is judged by the same real clock the age labels read, so a row can
  // never render "3d" without the stale mark that ought to accompany it.
  buildHumanInboxViewModel({ folder: "tachyon", wsHash: "ws-1", approvals, validations, savedAgentProposals });

/**
 * SDD 482 phase 4C — a Saved Agent proposal, built through the REAL review projection so the shot
 * cannot show a field the projection would have stripped. The environment value below is the point:
 * it must not appear anywhere in the rendered pane.
 */
const proposalSource = () => ({
      id: "sp-4f1a2b",
      proposer: "claude-runtime",
      proposerKind: "agent",
      createdAt: hoursAgo(5),
      expiresAt: new Date(Date.now() + 19 * 60 * 60 * 1000).toISOString(),
      digest: "9f".repeat(32),
      base: { configSha256: "a".repeat(64) },
      spec: {
        name: "nightly-importer",
        runtimeAdapter: "claude",
        executable: "claude",
        rationale:
          "The nightly import currently runs inside my own session, so it dies whenever I am restarted. " +
          "A Saved Agent would own it and survive reloads.",
        environment: { ANTHROPIC_API_KEY: "sk-ant-DO-NOT-RENDER-THIS", IMPORT_REGION: "eu-west-1" },
        ownsSubagents: ["import-checker"],
        capabilities: { mcp: ["fetch"], hooks: ["preflight"], skills: ["review"] },
      },
});

const proposalReview = (currentConfigSha256 = "a".repeat(64)): SavedAgentProposalReview =>
  buildSavedAgentProposalReview({ proposal: proposalSource() as never, currentConfigSha256, nowMs: Date.now() });

/**
 * The codicon @font-face points at a RELATIVE url, which resolves to nothing under `setContent` — so
 * every icon renders as an empty box and the shots under-report what the surface shows (the picker's
 * prev/next affordances most of all). Inlining the real font makes the evidence honest.
 */
function inlineCodiconFont(css: string): string {
  const font = readFileSync(path.join(DIST, "codicon.ttf")).toString("base64");
  return css.replace(/url\(["']?\.\/codicon\.ttf[^)]*["']?\)/, `url(data:font/ttf;base64,${font})`);
}

function pageHtml(bodyHtml: string, width: number): string {
  const css = ["codicon.css", "design-system.css", "vscode-theme.css", "human-inbox.css", "cockpit.css"]
    .map((f) => {
      const raw = readFileSync(path.join(DIST, f), "utf8");
      return `<style>${f === "codicon.css" ? inlineCodiconFont(raw) : raw}</style>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">${css}
<style>
  /* VS Code supplies these at runtime; pin a dark-theme approximation so the shot is deterministic. */
  :root {
    --vscode-sideBar-background:#181818; --vscode-editor-background:#1f1f1f; --vscode-foreground:#cccccc;
    --vscode-font-family:system-ui,sans-serif; --vscode-font-size:13px;
    --vscode-descriptionForeground:#9d9d9d; --vscode-disabledForeground:#8a8a8a;
    --vscode-list-hoverBackground:#2a2d2e; --vscode-panel-border:#2b2b2b;
    --vscode-badge-background:#4d4d4d; --vscode-badge-foreground:#fff;
    --vscode-input-background:#313131; --vscode-textCodeBlock-background:#0000004d;
    --vscode-button-background:#0078d4; --vscode-button-foreground:#fff;
    --vscode-charts-green:#89d185; --vscode-charts-yellow:#cca700; --vscode-charts-red:#f14c4c;
    --vscode-charts-blue:#3794ff; --vscode-charts-purple:#b180d7;
    --vscode-errorForeground:#f14c4c; --vscode-list-warningForeground:#cca700;
    --vscode-widget-border:#3c3c3c; --vscode-editorWidget-border:#3c3c3c; --vscode-focusBorder:#0078d4;
  }
  html, body { margin:0; }
  body { width:${width}px; background: var(--vscode-editor-background); }
  #shot { width:${width}px; }
</style></head><body><div id="shot">${bodyHtml}</div></body></html>`;
}

describe("Human Inbox — durable previews and the narrow-viewport guarantee", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: unknown) => unknown;
  let ItemApp: (props: unknown) => unknown;
  const written: string[] = [];
  const noopDispatch = { refresh() {}, open() {}, resolveApproval() {}, closeValidation() {}, assignValidation() {}, decideSavedAgentProposal() {} };

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const mod = await loadWebviewModule(path.resolve(__dirname, "../../src/webview/human-inbox/App.tsx"));
    App = mod.App as typeof App;
    ItemApp = mod.ItemApp as typeof ItemApp;
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (written.length) {
      writeFileSync(
        path.join(OUT_DIR, "README.md"),
        `# Human Inbox (t-e76acc) — rendered states\n\nRendered by \`test/browser/humanInboxShots.test.ts\` from the real \`App\`/\`ItemApp\`\nand the shipped \`dist/webview/human-inbox.css\`. Every shot is also asserted not to scroll\nhorizontally at its width. Regenerate with:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/humanInboxShots.test.ts\n\`\`\`\n\n${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  /**
   * Shoot one state at one width, and prove the page does not scroll sideways there.
   *
   * The overflow check is the assertion that matters: a preview surface renders content nobody sized
   * for this panel, so "it fits" has to be measured, not eyeballed.
   */
  async function shoot(name: string, bodyHtml: string, width: number): Promise<void> {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 });
    await page.setContent(pageHtml(bodyHtml, width), { waitUntil: "load" });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `${name} scrolls horizontally at ${width}px`).toBeLessThanOrEqual(overflow.clientWidth);
    const target = await page.$("#shot");
    const file = path.join(OUT_DIR, `${name}.png`);
    await target!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  it("shoots the aggregated LIST — both kinds, one count", async () => {
    const vm = vmOf(
      [approval("a-4f1a2b"), approval("a-77c301", { createdAt: hoursAgo(72), requester: "claude-opus5-2" })],
      [validation("v-91ab04"), validation("v-33ef12", { title: "Confirm the narrow sidebar still reads at 220px", priority: 2 })],
    );
    const html = renderStatic(App({ vm, dispatch: noopDispatch }));
    for (const w of WIDTHS) await shoot(`list-${w.id}`, html, w.px);
  }, 60_000);

  /**
   * SDD 482 phase 4C — the pane where a human creates durable authority.
   *
   * Two things are being measured, and only one of them is layout. The shot exists so a person can
   * judge whether the consequences read clearly at a glance; the ASSERTION is that the environment
   * VALUE never reaches the DOM. A review pane that echoed a pasted token would put it into this very
   * screenshot, which is the most durable place a credential could possibly land.
   */
  it("shoots a SAVED AGENT PROPOSAL item — and proves no secret value reaches the pane", async () => {
    const vm = vmOf([], [], [proposalReview()]);
    const item = buildHumanInboxItemViewModel(vm, "saved-agent-proposal", "sp-4f1a2b");
    expect(item, "the proposal must open under its own kind, not a validation route").toBeTruthy();
    const html = renderStatic(ItemApp({ vm: item, dispatch: noopDispatch }));

    expect(html).not.toContain("sk-ant-DO-NOT-RENDER-THIS");
    expect(html).toContain("ANTHROPIC_API_KEY");        // the NAME is shown…
    expect(html).toContain("new canonical profile");     // …and so is what approving writes
    expect(html).toContain("Created enabled; not started");
    for (const w of WIDTHS) await shoot(`item-saved-agent-proposal-${w.id}`, html, w.px);
  }, 60_000);

  it("shoots a proposal whose base MOVED — the approve button must be visibly unavailable", async () => {
    const vm = vmOf([], [], [proposalReview("b".repeat(64))]); // the roster changed since the proposal
    const item = buildHumanInboxItemViewModel(vm, "saved-agent-proposal", "sp-4f1a2b");
    const html = renderStatic(ItemApp({ vm: item, dispatch: noopDispatch }));
    // Disabled in the markup, not merely refused later: the human sees why before pressing.
    expect(html).toMatch(/data-testid="inbox-approve-saved-agent"[^>]*disabled/);
    expect(html).toContain("no longer be committed as reviewed");
    for (const w of WIDTHS) await shoot(`item-saved-agent-proposal-diverged-${w.id}`, html, w.px);
  }, 60_000);

  it("renders a Saved Agent commit refusal on the detail route instead of making approve look inert", async () => {
    const vm = vmOf([], [], [proposalReview()]);
    const item = buildHumanInboxItemViewModel(vm, "saved-agent-proposal", "sp-4f1a2b");
    const refusal =
      "commit_failed: permissions.defaultMode value bypassPermissions must be authorized explicitly";
    // t-58f9e9 — the error crosses as a RECEIPT, not a bare string, so an identical refusal twice in
    // a row is still two refusals to the component that clears its pending state.
    const html = renderStatic(ItemApp({ vm: item, dispatch: noopDispatch, error: { message: refusal } }));

    expect(html).toContain('data-testid="inbox-saved-agent-error"');
    expect(html).toContain(refusal);
    expect(html).toContain('role="alert"');
  });

  it("shoots an APPROVAL item — verbatim payload above the decision", async () => {
    const vm = vmOf([approval("a-4f1a2b")], []);
    const item = buildHumanInboxItemViewModel(vm, "approval", "a-4f1a2b");
    const html = renderStatic(ItemApp({ vm: item, dispatch: noopDispatch }));
    for (const w of WIDTHS) await shoot(`item-approval-${w.id}`, html, w.px);
  }, 60_000);

  it("shoots NO ARTIFACTS — the state that must never read as 'evidence checked'", async () => {
    const vm = vmOf([], [validation("v-91ab04")]);
    const item = buildHumanInboxItemViewModel(vm, "validation", "v-91ab04");
    expect(item?.artifacts).toEqual([]);
    for (const w of WIDTHS) await shoot(`item-no-artifacts-${w.id}`, renderStatic(ItemApp({ vm: item, dispatch: noopDispatch })), w.px);
  }, 60_000);

  it("shoots ONE IMAGE, and a very wide one — the case a stylesheet has to cap", async () => {
    const vm = vmOf([], [validation("v-91ab04", { sourceRefs: [{ type: "screenshot", ref: "shots/wide.png" }] })]);
    const item = buildHumanInboxItemViewModel(vm, "validation", "v-91ab04", {
      workspaceRoot: "/ws",
      load: () => ({ image: WIDE_PNG }),
    });
    // 2400px of evidence inside a 360px panel: if the page scrolls, shoot() fails.
    for (const w of WIDTHS) await shoot(`item-one-image-${w.id}`, renderStatic(ItemApp({ vm: item, dispatch: noopDispatch })), w.px);
  }, 60_000);

  it("shoots SEVERAL artifacts — the picker that steps through them without leaving the inbox", async () => {
    const vm = vmOf(
      [],
      [
        validation("v-91ab04", {
          sourceRefs: [{ type: "task", ref: "t-e76acc" }],
          rounds: [
            {
              n: 1,
              evidenceRefs: [
                { type: "screenshot", ref: "shots/inbox-list-at-a-very-long-descriptive-name.png" },
                { type: "screenshot", ref: "shots/inbox-detail.png" },
                { type: "prototype", ref: "protos/inbox.html" },
                { type: "url", ref: "https://example.test/runs/1138" },
              ],
            },
          ],
        }),
      ],
    );
    const item = buildHumanInboxItemViewModel(vm, "validation", "v-91ab04", {
      workspaceRoot: "/ws",
      load: (_p, kind) => (kind === "image" ? { image: TINY_PNG } : { prototype: "<p>never rendered — the picker starts on the first artifact</p>" }),
    });
    expect(item?.artifactSummary.total).toBe(5);
    for (const w of WIDTHS) await shoot(`item-many-artifacts-${w.id}`, renderStatic(ItemApp({ vm: item, dispatch: noopDispatch })), w.px);
  }, 60_000);

  it("shoots a PROTOTYPE — sandboxed srcdoc, watermarked as untrusted", async () => {
    const proto = assembleUntrustedSrcdoc(
      `<html><body style="font-family:system-ui;padding:24px"><h1>Inbox mock</h1><p>A prototype attached as evidence.</p><script>document.title="should never run"</script></body></html>`,
      { mode: "prototype-static" },
    );
    const vm = vmOf([], [validation("v-91ab04", { sourceRefs: [{ type: "prototype", ref: "protos/inbox.html" }] })]);
    const item = buildHumanInboxItemViewModel(vm, "validation", "v-91ab04", {
      workspaceRoot: "/ws",
      load: () => ({ prototype: proto }),
    });
    for (const w of WIDTHS) await shoot(`item-prototype-${w.id}`, renderStatic(ItemApp({ vm: item, dispatch: noopDispatch })), w.px);
  }, 60_000);

  it("shoots an UNAVAILABLE reference — named, reasoned, and never mistaken for a passing check", async () => {
    const vm = vmOf(
      [],
      [validation("v-91ab04", { sourceRefs: [{ type: "screenshot", ref: ".tachyon/evidence/deleted-by-a-worktree-prune.png" }] })],
    );
    const item = buildHumanInboxItemViewModel(vm, "validation", "v-91ab04", {
      workspaceRoot: "/ws",
      load: () => ({ unavailable: "file not found" }),
    });
    for (const w of WIDTHS) await shoot(`item-unavailable-${w.id}`, renderStatic(ItemApp({ vm: item, dispatch: noopDispatch })), w.px);
  }, 60_000);

  it("shoots the GONE state — resolved or closed while the human was reading", async () => {
    const html = renderStatic(ItemApp({ missing: { kind: "approval", id: "a-4f1a2b" }, dispatch: noopDispatch }));
    for (const w of WIDTHS) await shoot(`item-gone-${w.id}`, html, w.px);
  }, 60_000);
});
