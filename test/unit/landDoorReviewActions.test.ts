/**
 * SDD 501 — the land block offers a way to LOOK before it offers a way to land.
 *
 * The defect this proves closed is placement, not absence: diff review (spec 213/230) and PR creation
 * (spec 223) were already built and already reachable — from the sidebar agent row, one room away from
 * the decision. Measured 2026-08-09 on the coordinating agent's own behaviour: seven merges, seven
 * trips to a terminal to run `git diff`, with the land block open beside it showing five green checks.
 *
 * So what is asserted here is REACH, plus the two properties that make the reach honest:
 *   · the buttons post the actions the host listens for (the handler is CALLED, not just rendered —
 *     a handler that exists and posts nothing is the failure mode a `[fn]` attribute cannot see);
 *   · the block names what the review compares (notes.md § D2: `trunkRef..head`, committed), because
 *     a review that silently showed the working tree would look like proof of the wrong thing.
 *
 * Nothing here renders a diff. The actions dispatch to commands that open VS Code's own diff editor;
 * `singleDiffReviewImplementation.test.ts` is the guard that keeps it that way.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStaticWithElements, type RenderedElement } from "../helpers/staticPreact.js";
import { strings as fixtureStrings } from "../../scripts/webview-preview/fixtures/cockpit.js";
import { buildSectionsModel, type WorkspaceBundle, type WorktreeRow } from "@tachyon/webview-ui/sections/model";
import { landSuggestion, type LandFacts } from "@tachyon/engine/worktree/land.js";
import type { WorktreesAction } from "@tachyon/webview-ui/webview/worktrees/messages.js";

const SHELL_TSX = path.join(__dirname, "../../packages/webview-ui/src/webview/worktrees/App.tsx");
const HEAD = "9f3c1ab27d5e408b6c1d90ffae2b7c1d4e88a021";

const FACTS: LandFacts = {
  head: HEAD,
  branch: "tachyon/change/x",
  trunkRef: "main",
  primaryPath: "/home/goat/tachyon",
  dirty: false,
  commits: 2,
  verified: { tree: "41d0c7a9be2201fe3b6c8d47a05e91cc73b2f8de", at: "2026-08-07T16:41:09.220Z" },
  trunkIsAncestorOfHead: true,
  trunkHead: null,
  primaryBranch: "main",
  primaryDirty: false,
};

const UNLANDED = {
  state: "needs-review" as const,
  reasons: ["2 commit(s) not contained in base or in 'main'"],
  pathExists: true,
  dirty: false,
  aheadOfBase: 2,
  containedInBase: false,
  containedInTrunk: false,
  trunkRef: "main",
};

function row(over: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id: "mw-change-x",
    kind: "change",
    path: "/cache/wt/h/change/x",
    branch: "tachyon/change/x",
    status: "active",
    slug: "x",
    folder: "tachyon",
    wsHash: "h",
    tachyonCreatedBranch: true,
    classification: UNLANDED,
    land: landSuggestion(FACTS),
    ...over,
  };
}

function bundle(worktrees: WorktreeRow[]): WorkspaceBundle {
  return {
    control: {
      folderName: "tachyon",
      workspaceRoot: "/w",
      wsHash: "h",
      bridgeUrl: "http://127.0.0.1:1",
      identity: null,
      notes: [],
    } as WorkspaceBundle["control"],
    agents: [],
    worktrees,
    approvals: [],
  };
}

describe("SDD 501 — review and propose reach the land block", () => {
  let Shell: (props: unknown) => unknown;
  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  const render = (rows: WorktreeRow[]): { html: string; elements: RenderedElement[]; posted: WorktreesAction[] } => {
    const posted: WorktreesAction[] = [];
    const out = renderStaticWithElements(Shell({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle(rows)], { section: "worktrees", wsHash: "h" }),
      post: (action: WorktreesAction) => posted.push(action),
    }));
    return { ...out, posted };
  };

  /** Click the one button carrying `label` — the human's own path to the action. */
  const click = (elements: RenderedElement[], label: string): void => {
    const hits = elements.filter((el) => el.tag === "button" && el.html.includes(label));
    expect(hits, `no button labelled '${label}'`).toHaveLength(1);
    (hits[0].props.onClick as () => void)();
  };

  it("offers review and propose from the block where the land decision is made", () => {
    const { html } = render([row()]);
    expect(html).toContain(fixtureStrings.landTitle);
    expect(html).toContain(fixtureStrings.landReview);
    expect(html).toContain(fixtureStrings.landPropose);
  });

  it("review dispatches the worktree's id to the host, and renders no diff of its own", () => {
    const { elements, posted, html } = render([row()]);
    click(elements, fixtureStrings.landReview);
    expect(posted).toEqual([{ type: "worktreeReviewDiff", id: "mw-change-x", wsHash: "h" }]);
    // The webview asks; VS Code's own diff editor answers. Nothing here draws a changed line.
    expect(html).not.toMatch(/diff-hunk|ck-diff|<ins\b|<del\b/);
  });

  it("propose dispatches its own action — never the review one, never a new flow", () => {
    const { elements, posted } = render([row()]);
    click(elements, fixtureStrings.landPropose);
    expect(posted).toEqual([{ type: "worktreeCreatePr", id: "mw-change-x", wsHash: "h" }]);
  });

  /**
   * notes.md § D2. The comparison is `trunkRef..head` — committed history, the same commits the land
   * command would introduce — and the block says so. A land block that offered review WITHOUT naming
   * its base would be worse than one that offered none: it reads as proof about what lands.
   */
  it("names the base it compares against, and says the comparison is committed", () => {
    const { html } = render([row()]);
    expect(html).toContain("main");
    expect(html).toContain(HEAD.slice(0, 12));
    expect(html).toContain(fixtureStrings.landCompare.replace("{0}", "main").replace("{1}", HEAD.slice(0, 12)));
  });

  /**
   * A blocked land is when looking matters MOST — the human is deciding what to fix. The command is
   * still withheld (t-7cb971's rule is untouched); only the two read-only doors stay open.
   */
  it("keeps review and propose reachable when the checks are red, with still no command", () => {
    const { html, elements, posted } = render([row({ land: landSuggestion({ ...FACTS, verified: null }) })]);
    expect(html).toContain(fixtureStrings.landBlocked.replace("{0}", "1"));
    expect(html).not.toContain("merge --ff-only");
    expect(html).not.toContain(fixtureStrings.landCopyCommand);
    expect(html).not.toContain(fixtureStrings.landCompare.replace("{0}", "main").replace("{1}", HEAD.slice(0, 12)));
    expect(html).toContain("Review opens a committed-history comparison, not the working tree.");
    click(elements, fixtureStrings.landReview);
    click(elements, fixtureStrings.landPropose);
    expect(posted.map((action) => action.type)).toEqual(["worktreeReviewDiff", "worktreeCreatePr"]);
  });

  /** spec.md § "no forge, no door": a worktree with no branch has nothing to propose and nothing to name. */
  it("withholds propose when the worktree has no branch, and still offers review", () => {
    const { html } = render([row({ land: landSuggestion({ ...FACTS, branch: "" }) })]);
    expect(html).toContain(fixtureStrings.landReview);
    expect(html).not.toContain(fixtureStrings.landPropose);
  });

  /**
   * t-ea5425 — the file is chosen HERE, in the product picker, not in VS Code's chrome.
   *
   * The host owns the candidate list (only it can read git) and the choice goes straight back to it —
   * the shape `activity/messages.ts:74` already declares for this product ("chosen in-webview
   * QuickPicker (not vscode.showQuickPick)"). The picker is driven by the host's push and nothing else:
   * a webview that kept its own copy of the list could show a file the host never measured.
   */
  const REVIEW = {
    id: "mw-change-x",
    label: "tachyon/change/x",
    base: "main",
    current: HEAD.slice(0, 12),
    files: [
      { path: "src/one.ts", status: "M" },
      { path: "src/two.ts", status: "A", from: "src/old.ts" },
    ],
  };

  const renderPicker = (over: Record<string, unknown> = {}) => {
    const posted: WorktreesAction[] = [];
    const closed: number[] = [];
    const out = renderStaticWithElements(Shell({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle([row()])], { section: "worktrees", wsHash: "h" }),
      post: (action: WorktreesAction) => posted.push(action),
      reviewFiles: REVIEW,
      onCloseReviewFiles: () => closed.push(1),
      ...over,
    }));
    return { ...out, posted, closed };
  };

  it("draws the product picker over the card, listing every changed file the host sent", () => {
    const { html, elements } = renderPicker();
    expect(html).toContain('data-testid="worktree-review-picker"');
    // The picker's own chrome names what is being compared, in the sentences the native list used.
    expect(html).toContain("Review 'tachyon/change/x' — 2 changed file(s)");
    expect(html).toContain(`main ↔ ${HEAD.slice(0, 12)}`);
    const options = elements.filter((el) => el.props["data-testid"] === "worktree-review-picker-item");
    expect(options).toHaveLength(2);
    expect(options.map((el) => el.props["data-id"])).toEqual(["src/one.ts", "src/two.ts"]);
    // A rename still names both of its paths, exactly as the native list did.
    expect(options[1].html).toContain("src/old.ts → src/two.ts");
  });

  it("posts the chosen file to the host and closes — it opens no diff of its own", () => {
    const { elements, posted, closed, html } = renderPicker();
    const option = elements.find((el) => el.props["data-id"] === "src/two.ts");
    expect(option, "no option for src/two.ts").toBeDefined();
    (option!.props.onClick as () => void)();
    expect(posted).toEqual([{ type: "worktreeOpenReviewFile", id: "mw-change-x", path: "src/two.ts" }]);
    expect(closed).toEqual([1]);
    expect(html).not.toMatch(/diff-hunk|ck-diff|<ins\b|<del\b/);
  });

  it("shows no picker until the host sends candidates", () => {
    const { html } = renderPicker({ reviewFiles: null });
    expect(html).not.toContain('data-testid="worktree-review-picker"');
  });

  it("offers neither on a row the engine sent no land suggestion for", () => {
    const { html } = render([row({
      land: undefined,
      classification: { ...UNLANDED, state: "ready-to-remove", reasons: [], aheadOfBase: 0, containedInBase: true, containedInTrunk: true },
    })]);
    expect(html).not.toContain(fixtureStrings.landReview);
    expect(html).not.toContain(fixtureStrings.landPropose);
  });

  /**
   * t-f3ded3 — the PR title is collected HERE, in the product ConfirmForm, not in VS Code's chrome.
   *
   * The host owns the draft (probe + compose); the webview owns the field, the multi-line body
   * preview, the meta lines, and Confirm/Cancel. Panel close mid-flow is cancel: clearing the draft
   * posts nothing, so no create runs.
   */
  const PR_DRAFT = {
    id: "mw-change-x",
    subject: "tachyon/change/x",
    branch: "tachyon/change/x",
    title: "Change x",
    body: "Branch `tachyon/change/x` → `main`.\n\n🤖 Opened from a Tachyon worktree.",
    base: "main" as string | null,
    dirty: true,
  };

  const renderPrForm = (over: Record<string, unknown> = {}) => {
    const posted: WorktreesAction[] = [];
    const closed: number[] = [];
    const out = renderStaticWithElements(Shell({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle([row()])], { section: "worktrees", wsHash: "h" }),
      post: (action: WorktreesAction) => posted.push(action),
      prDraft: PR_DRAFT,
      onClosePrDraft: () => closed.push(1),
      ...over,
    }));
    return { ...out, posted, closed };
  };

  it("draws ConfirmForm over the card with title, body preview, and meta", () => {
    const { html } = renderPrForm();
    expect(html).toContain('data-testid="worktree-pr-form"');
    expect(html).toContain("Create PR for 'tachyon/change/x'");
    expect(html).toContain("Open a GitHub PR for branch 'tachyon/change/x'?");
    expect(html).toContain("Change x");
    expect(html).toContain("Branch `tachyon/change/x` → `main`");
    expect(html).toContain("Base branch: main");
    expect(html).toContain("Uncommitted changes won't be in the PR");
    expect(html).toContain(fixtureStrings.landPrConfirm);
  });

  it("posts the confirmed title to the host and closes — it creates no PR of its own", () => {
    const { elements, posted, closed } = renderPrForm();
    const confirm = elements.find((el) => el.props["data-testid"] === "worktree-pr-form-confirm");
    expect(confirm, "no confirm button").toBeDefined();
    (confirm!.props.onClick as () => void)();
    expect(posted).toEqual([{ type: "worktreeConfirmPr", id: "mw-change-x", title: "Change x" }]);
    expect(closed).toEqual([1]);
  });

  it("cancel closes without posting a confirm", () => {
    const { elements, posted, closed } = renderPrForm();
    const cancel = elements.find((el) => el.props["data-testid"] === "worktree-pr-form-cancel");
    expect(cancel, "no cancel button").toBeDefined();
    (cancel!.props.onClick as () => void)();
    expect(posted).toEqual([]);
    expect(closed).toEqual([1]);
  });

  it("shows no form until the host sends a draft", () => {
    const { html } = renderPrForm({ prDraft: null });
    expect(html).not.toContain('data-testid="worktree-pr-form"');
  });

  it("names gh's default when the worktree has no persisted base", () => {
    const { html } = renderPrForm({ prDraft: { ...PR_DRAFT, base: null, dirty: false } });
    expect(html).toContain(fixtureStrings.landPrBaseDefault);
    expect(html).not.toContain("Uncommitted changes won't be in the PR");
  });
});
