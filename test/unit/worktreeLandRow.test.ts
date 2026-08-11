/**
 * t-7cb971 — the half of "suggest and copy" a human touches.
 *
 * The engine half (which preconditions, what proves them, when a command is withheld) is proved in
 * landSuggestion.test.ts. This asserts the surface those facts arrive at: that a green delivery hands
 * over the command with a copy action WIRED to it, and — the case that matters more — that a blocked
 * delivery hands over nothing but reasons and exits. A suggestion that does not check is worse than
 * no suggestion, so "the command is absent" is the assertion this file exists for.
 *
 * Rendered through the real shell, so what is asserted is the rendered surface rather than a
 * description of the source.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic, renderStaticWithElements, type RenderedElement } from "../helpers/staticPreact.js";
import { strings as fixtureStrings } from "../../scripts/webview-preview/fixtures/cockpit.js";
import { buildSectionsModel, type WorkspaceBundle, type WorktreeRow } from "../../src/sections/model.js";
import { landSuggestion, type LandFacts } from "../../src/worktree/land.js";

const SHELL_TSX = path.join(__dirname, "../../src/webview/worktrees/App.tsx");
const HEAD = "9f3c1ab27d5e408b6c1d90ffae2b7c1d4e88a021";

/**
 * The land block is composed by the ENGINE, so the fixture calls the engine composer rather than
 * hand-writing a `land` payload. A hand-written one would let this file keep passing while the rule
 * it depends on — no command unless every check is green — changed underneath it.
 */
const FACTS: LandFacts = {
  head: HEAD,
  branch: "tachyon/change/x",
  trunkRef: "main",
  primaryPath: "/home/goat/tachyon",
  dirty: false,
  commits: 2,
  verified: { tree: "41d0c7a9be2201fe3b6c8d47a05e91cc73b2f8de", at: "2026-08-07T16:41:09.220Z" },
  trunkIsAncestorOfHead: true,
  primaryBranch: "main",
  primaryDirty: false,
};

const UNLANDED = {
  state: "needs-review" as const,
  reasons: ["2 commit(s) not contained in base or in 'main'; land or integrate them into the trunk before removing"],
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
      agents: { total: 0, running: 0 },
      authConfigured: "unknown",
      notes: [],
    } as WorkspaceBundle["control"],
    agents: [],
    worktrees,
    approvals: [],
  };
}

describe("t-7cb971 — the land suggestion on a Worktrees row", () => {
  let Shell: (props: unknown) => unknown;
  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  const renderWith = (rows: WorktreeRow[], post: (a: unknown) => void = () => {}): string =>
    renderStatic(Shell({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle(rows)], { section: "worktrees", wsHash: "h" }),
      post,
    }));

  it("shows the exact command, every precondition, and what proved each one", () => {
    const html = renderWith([row()]);
    expect(html).toContain(fixtureStrings.landTitle);
    expect(html).toContain(`git -C /home/goat/tachyon merge --ff-only ${HEAD}`);
    expect(html).toContain(fixtureStrings.landCopyCommand);
    // Every check is named, whether or not it passed: a list that appears only on failure cannot be
    // told apart from a list that is broken.
    for (const label of [
      fixtureStrings.landCheckWorktreeClean,
      fixtureStrings.landCheckVerifiedTree,
      fixtureStrings.landCheckFastForward,
      fixtureStrings.landCheckPrimaryOnTrunk,
      fixtureStrings.landCheckPrimaryClean,
    ]) expect(html).toContain(label);
    expect(html).toContain("verified at 2026-08-07T16:41:09.220Z");
  });

  it("hands over NO command when a precondition is unproved, and says which and what to do", () => {
    const land = landSuggestion({ ...FACTS, verified: null });
    const html = renderWith([row({ land })]);
    expect(html).not.toContain("merge --ff-only");
    expect(html).not.toContain(fixtureStrings.landCopyCommand);
    expect(html).toContain("no verify record");
    expect(html).toContain(fixtureStrings.landFixLabel);
    expect(html).toContain(fixtureStrings.landBlocked.replace("{0}", "1"));
  });

  it("renders nothing at all for a row the engine sent no suggestion for", () => {
    const html = renderWith([row({
      land: undefined,
      classification: { ...UNLANDED, state: "ready-to-remove", reasons: [], aheadOfBase: 0, containedInBase: true, containedInTrunk: true },
    })]);
    expect(html).not.toContain(fixtureStrings.landTitle);
    expect(html).not.toContain("merge --ff-only");
  });

  it("offers it on an OCCUPIED row too — a live agent blocks removal, not landing", () => {
    const html = renderWith([row({
      classification: { ...UNLANDED, state: "occupied", reasons: ["occupied by 'codex' (live)"], occupant: { state: "live", agent: "codex", cwd: "/cache/wt/h/change/x" } },
    })]);
    expect(html).toContain(fixtureStrings.landTitle);
    expect(html).toContain(`merge --ff-only ${HEAD}`);
  });

  it("never shows a copy control without a command, or a command without one", () => {
    // The pairing is the claim. A copy button beside nothing is a dead control; a command with no way
    // to take it is the hand-typing this replaces. Both directions, over every check, one at a time.
    for (const override of [
      {}, { dirty: true }, { verified: null }, { trunkIsAncestorOfHead: false },
      { primaryBranch: "other" }, { primaryDirty: true }, { primaryPath: null },
    ] as Array<Partial<LandFacts>>) {
      const land = landSuggestion({ ...FACTS, ...override });
      const html = renderWith([row({ land })]);
      const hasCommand = html.includes("merge --ff-only");
      expect(hasCommand, JSON.stringify(override)).toBe(html.includes(fixtureStrings.landCopyCommand));
      expect(hasCommand, JSON.stringify(override)).toBe(land.command !== undefined);
    }
  });

  /**
   * t-ea5425 — the block is the ROW's, not its text column's.
   *
   * `detail` sits inside `.ds-list-row-main`, which shares the row's line with the action buttons, so a
   * land block placed there is laid out in whatever is left over: measured at 880 with the preview
   * harness, 480px of an 824px card (0.58), with the one actionable `Fix:` sentence broken over three
   * lines. The pixel claim belongs to the visual pass (`scripts/visual-qa/worktrees-land-card.mjs`);
   * what is asserted HERE is the structural fact that pass depends on, because a later refactor that
   * moves the block back into `detail` would keep every other assertion in this file green.
   */
  it("renders the block in the row footer, never inside the row's text column", () => {
    const { elements } = renderStaticWithElements(Shell({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle([row()])], { section: "worktrees", wsHash: "h" }),
      post: () => {},
    }));
    const withClass = (name: string): RenderedElement[] =>
      elements.filter((el) => String(el.props.class ?? "").split(" ").includes(name));

    const footers = withClass("ds-list-row-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0].html).toContain('data-testid="worktree-land"');
    // The path stays in `detail`, where `word-break: break-all` is right for it — and the block does not.
    for (const detail of withClass("ds-list-row-detail")) {
      expect(detail.html).not.toContain('data-testid="worktree-land"');
      expect(detail.html).toContain("/cache/wt/h/change/x");
    }
    // The wrap modifier is what lets the footer take a line of its own; without it the block would be
    // laid out beside the actions again, on a row that merely LOOKS like it has a footer.
    expect(withClass("ds-list-row-has-footer")).toHaveLength(1);
  });

  /** A row with no land suggestion asks for no footer at all — and so keeps the unwrapped row it had. */
  it("adds no footer to a row the engine sent no suggestion for", () => {
    const { elements } = renderStaticWithElements(Shell({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle([row({
        land: undefined,
        classification: { ...UNLANDED, state: "ready-to-remove", reasons: [], aheadOfBase: 0, containedInBase: true, containedInTrunk: true },
      })])], { section: "worktrees", wsHash: "h" }),
      post: () => {},
    }));
    const classes = elements.map((el) => String(el.props.class ?? ""));
    expect(classes.some((c) => c.split(" ").includes("ds-list-row-footer"))).toBe(false);
    expect(classes.some((c) => c.split(" ").includes("ds-list-row-has-footer"))).toBe(false);
  });

  it("two rows with different verdicts do not decide for each other", () => {
    const html = renderWith([
      row(),
      row({ id: "mw-change-y", path: "/cache/wt/h/change/y", branch: "tachyon/change/y", slug: "y", land: landSuggestion({ ...FACTS, primaryDirty: true }) }),
    ]);
    expect(html).toContain(`merge --ff-only ${HEAD}`);
    expect(html).toContain("the primary checkout has uncommitted changes");
    expect(html).toContain(fixtureStrings.landBlocked.replace("{0}", "1"));
  });
});
