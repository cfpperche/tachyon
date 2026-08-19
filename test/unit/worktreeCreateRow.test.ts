/**
 * t-0ab150 — the Worktrees tab must not treat a create-session row as a live checkout.
 *
 * The silent undo: if grouping/selection only look at hygiene classification, a session row that
 * happens to carry `ready-to-remove` (or that lands in that group because classification is absent
 * and a later change rewrites the default) becomes selectable for cleanup. The create field is
 * what excludes it — not the group it would otherwise fall into.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { strings as fixtureStrings } from "../../scripts/webview-preview/fixtures/cockpit.js";
import { buildSectionsModel, type WorkspaceBundle, type WorktreeRow } from "@tachyon/webview-ui/sections/model";

const SHELL_TSX = path.join(__dirname, "../../packages/webview-ui/src/webview/worktrees/App.tsx");

const READY = {
  state: "ready-to-remove" as const,
  reasons: [] as string[],
  pathExists: true,
  dirty: false,
  aheadOfBase: 0,
  containedInBase: true,
  containedInTrunk: true,
  trunkRef: "main",
};

function changeRow(over: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id: "mw-change-creating",
    kind: "change",
    path: "/cache/wt/h/change/creating",
    branch: "tachyon/change/creating",
    status: "creating",
    slug: "creating",
    folder: "tachyon",
    wsHash: "h",
    tachyonCreatedBranch: true,
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

describe("t-0ab150 — create-session row is not cleanup-eligible", () => {
  let Shell: (props: unknown) => unknown;

  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  const render = (rows: WorktreeRow[]): string =>
    renderStatic(Shell({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle(rows)], { section: "worktrees", wsHash: "h" }),
      post: () => {},
    }));

  it("does not offer Remove or Select all even when classified ready-to-remove", () => {
    const html = render([changeRow({ create: { phase: "add" }, classification: READY })]);
    expect(html).toContain(fixtureStrings.wtPhaseAdd);
    expect(html).toContain('data-testid="worktree-creating"');
    expect(html).not.toContain('class="ck-wt-check"');
    expect(html).not.toContain(fixtureStrings.wtRemoveCheckout);
    expect(html).not.toContain(fixtureStrings.wtSelectAll);
    expect(html).not.toContain(fixtureStrings.wtReadyTitle);
  });

  it("keeps a failed create on the row and still withholds cleanup", () => {
    const html = render([changeRow({
      create: { phase: "add", error: "git worktree add failed: destination exists" },
      classification: READY,
    })]);
    expect(html).toContain("git worktree add failed: destination exists");
    expect(html).not.toContain('class="ck-wt-check"');
    expect(html).not.toContain(fixtureStrings.wtRemoveCheckout);
    expect(html).not.toContain(fixtureStrings.wtSelectAll);
  });

  it("does not count a session row as an active worktree", () => {
    const model = buildSectionsModel(
      [bundle([changeRow({ create: { phase: "validate" }, status: "active" })])],
      { section: "worktrees", wsHash: "h" },
    );
    expect(model.overview.worktreesActive).toBe(0);
    expect(model.worktrees).toHaveLength(1);
  });
});
