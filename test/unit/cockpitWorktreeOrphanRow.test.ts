/**
 * t-621613 — Control → Worktrees offers the removal control on an agent row whose agent is gone.
 *
 * The engine half (authority, classification, the actual checkout) is proved in
 * worktreeOrphanAgentHome.test.ts and workspaceHeadless.test.ts. This is the half a human touches,
 * and without it the engine half is unreachable from the UI: the tab hides every removal control for
 * `kind === "agent"` and says "Managed by Agent Studio → Forget" instead. That sentence is true while
 * somebody lives there and false once nobody does — Forget is reached BY NAME and needs a roster row
 * to list the agent and a ledger row to plan the removal, neither of which an orphan entry has. A
 * human following it finds no such agent, and the checkout ends up cleared with raw git.
 *
 * Rendered from the real shell through the static serializer, so what is asserted is the control's
 * presence and its wiring, not a description of the source.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { strings as fixtureStrings } from "../../scripts/webview-preview/fixtures/cockpit.js";
import { buildCockpitModel, type CockpitWorkspaceBundle, type CockpitWorktreeRow } from "../../src/sections/model.js";

const SHELL_TSX = path.join(__dirname, "../../src/webview/worktrees/App.tsx");

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

function agentRow(over: Partial<CockpitWorktreeRow> = {}): CockpitWorktreeRow {
  return {
    id: "mw-agent-ghost",
    kind: "agent",
    path: "/cache/wt/h/ghost",
    branch: "tachyon/ghost",
    status: "active",
    agent: "ghost",
    folder: "tachyon",
    wsHash: "h",
    tachyonCreatedBranch: true,
    classification: READY,
    ...over,
  };
}

function bundle(worktrees: CockpitWorktreeRow[]): CockpitWorkspaceBundle {
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
    } as CockpitWorkspaceBundle["control"],
    agents: [],
    worktrees,
    approvals: [],
  };
}

describe("t-621613 — the Worktrees tab and an agent home with nobody in it", () => {
  let Shell: (props: unknown) => unknown;

  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  const render = (rows: CockpitWorktreeRow[]): string =>
    renderStatic(Shell({
      strings: fixtureStrings,
      model: buildCockpitModel([bundle(rows)], { section: "worktrees", wsHash: "h" }),
      post: () => {},
    }));

  it("offers Remove checkout, and says why, when the agent is proved gone", () => {
    const html = render([agentRow({ ownerPresence: "absent" })]);
    expect(html).toContain(fixtureStrings.wtRemoveCheckout);
    expect(html).toContain(fixtureStrings.wtAgentGone);
    // The branch consent stays an explicit opt-in here like everywhere else — an orphan home's
    // branch is still a branch nobody proved was merged.
    expect(html).toContain(fixtureStrings.wtAlsoDeleteBranch);
    expect(html).not.toContain(fixtureStrings.wtAgentOwned);
  });

  it("keeps the read-only treatment while the agent is still there — and while nothing was measured", () => {
    // `unknown` is the one that would be easy to get wrong: an unreadable roster or an ambiguous
    // tmux read must leave the row exactly as it is today, not offer to delete somebody's home.
    for (const ownerPresence of ["present", "unknown", undefined] as const) {
      const html = render([agentRow(ownerPresence ? { ownerPresence } : {})]);
      expect(html, `ownerPresence '${ownerPresence}' must stay read-only`).toContain(fixtureStrings.wtAgentOwned);
      expect(html).not.toContain(fixtureStrings.wtRemoveCheckout);
      expect(html).not.toContain(fixtureStrings.wtAgentGone);
    }
  });

  it("leaves change worktrees exactly as they were — no orphan text, same control", () => {
    const html = render([{
      id: "mw-change-1", kind: "change", path: "/cache/wt/h/change/x", branch: "tachyon/change/x",
      status: "active", slug: "x", folder: "tachyon", wsHash: "h", tachyonCreatedBranch: true, classification: READY,
    }]);
    expect(html).toContain(fixtureStrings.wtRemoveCheckout);
    expect(html).not.toContain(fixtureStrings.wtAgentGone);
    expect(html).not.toContain(fixtureStrings.wtAgentOwned);
  });

  it("renders both agent rows side by side without one deciding for the other", () => {
    // The rows share a section and a renderer; a per-row decision read from shared state would show
    // up here as both rows agreeing.
    const html = render([
      agentRow({ ownerPresence: "absent" }),
      agentRow({ id: "mw-agent-codex", agent: "codex", path: "/cache/wt/h/codex", branch: "tachyon/codex", ownerPresence: "present" }),
    ]);
    expect(html).toContain(fixtureStrings.wtAgentGone);
    expect(html).toContain(fixtureStrings.wtAgentOwned);
  });
});
