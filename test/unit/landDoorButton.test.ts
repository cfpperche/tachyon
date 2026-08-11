/**
 * SDD 498 (t-7cb971) — the half of the governed land door a human touches.
 *
 * The engine half is proved in `landDoorAct.test.ts` (real git) and `landAct.test.ts` (scripted git).
 * This asserts the surface: that the act is offered only when every precondition is green, that it
 * posts the ROW ID rather than a sha, and — the two that carry the contract — that the command stays
 * visible beside the button, and that an outcome renders IN THE BLOCK rather than as a toast.
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
import type { WorktreeLandResult } from "../../src/webview/worktrees/messages.js";

const SHELL_TSX = path.join(__dirname, "../../src/webview/worktrees/App.tsx");
const HEAD = "9f3c1ab27d5e408b6c1d90ffae2b7c1d4e88a021";
const BEFORE = "41d0c7a9be2201fe3b6c8d47a05e91cc73b2f8de";

const GREEN: LandFacts = {
  head: HEAD,
  branch: "tachyon/change/x",
  trunkRef: "main",
  primaryPath: "/home/goat/tachyon",
  dirty: false,
  commits: 2,
  verified: { tree: BEFORE, at: "2026-08-11T16:41:09.220Z" },
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

function row(facts: LandFacts = GREEN): WorktreeRow {
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
    land: landSuggestion(facts),
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

describe("SDD 498 — the land button and its outcome", () => {
  let Shell: (props: unknown) => unknown;
  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  const props = (rows: WorktreeRow[], over: Record<string, unknown> = {}) => ({
    strings: fixtureStrings,
    model: buildSectionsModel([bundle(rows)], { section: "worktrees", wsHash: "h" }),
    post: () => {},
    ...over,
  });
  const renderWith = (rows: WorktreeRow[], over: Record<string, unknown> = {}): string =>
    renderStatic(Shell(props(rows, over)));

  it("offers the act on a green delivery, and keeps the command and Copy beside it", () => {
    const html = renderWith([row()]);
    expect(html).toContain(fixtureStrings.landAction);
    // The button is an ADDITION to the suggestion, never a replacement: both survive.
    expect(html).toContain(`git -C /home/goat/tachyon merge --ff-only ${HEAD}`);
    expect(html).toContain(fixtureStrings.landCopyCommand);
  });

  it("offers NO button at all when a precondition is red — not a disabled one", () => {
    const html = renderWith([row({ ...GREEN, primaryDirty: true })]);
    expect(html).not.toContain(fixtureStrings.landAction);
    expect(html).not.toContain("disabled");
    // It still refuses in words, with the exit.
    expect(html).toContain("commit or discard them there");
  });

  it("posts the row id and nothing else — never a sha the preconditions were not checked against", () => {
    const posted: unknown[] = [];
    const { elements } = renderStaticWithElements(Shell(props([row()], { post: (a: unknown) => posted.push(a) })));
    const land = elements.find((e: RenderedElement) => e.text === fixtureStrings.landAction);
    expect(land).toBeDefined();
    land!.click();
    expect(posted).toEqual([{ type: "worktreeLand", id: "mw-change-x", wsHash: "h" }]);
  });

  it("renders a success IN THE BLOCK, naming where the trunk moved and how to undo it", () => {
    const result: WorktreeLandResult = {
      id: "mw-change-x",
      ok: true,
      landed: { trunkRef: "main", primaryPath: "/home/goat/tachyon", before: BEFORE, after: HEAD },
    };
    const html = renderWith([row()], { landResult: result });
    expect(html).toContain("worktree-land-outcome");
    expect(html).toContain(BEFORE.slice(0, 12));
    expect(html).toContain(HEAD.slice(0, 12));
    // The undo target is git's own previous trunk head, offered where the human just watched it move.
    expect(html).toContain(`git -C /home/goat/tachyon reset --hard ${BEFORE.slice(0, 12)}`);
  });

  it("renders a refusal IN THE BLOCK with its exit — never only a toast that vanishes", () => {
    const result: WorktreeLandResult = {
      id: "mw-change-x",
      ok: false,
      reason: "'main' has moved to abcdef123456 and is no longer contained in 9f3c1ab27d5e",
      fix: "integrate 'main' into this branch and re-run the verify gate",
    };
    const html = renderWith([row()], { landResult: result });
    expect(html).toContain(fixtureStrings.landRefused);
    expect(html).toContain("has moved to abcdef123456");
    // t-2656d7 — the exit is the part that must not be lost. It is present and labelled.
    expect(html).toContain("integrate &#039;main&#039; into this branch and re-run the verify gate");
    expect(html).toContain(fixtureStrings.landFixLabel);
  });

  it("shows an outcome only on the row it names", () => {
    const other: WorktreeLandResult = { id: "mw-some-other-row", ok: false, reason: "nope", fix: "do a thing" };
    const html = renderWith([row()], { landResult: other });
    expect(html).not.toContain("worktree-land-outcome");
    expect(html).not.toContain("do a thing");
  });
});
