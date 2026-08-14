/**
 * t-d29398 — the human half of the door, rendered from the real shell.
 *
 * The engine half (the lock probe, the classification, `releaseLock`) is proved in
 * worktreeStuckLaunchLock.test.ts. Without this half it is unreachable: the owner's stuck checkout was
 * an AGENT worktree, and this tab hides every control on those and says "Managed by Agent Studio →
 * Forget" instead. That hand-off protects a checkout from being DELETED here; it must not also hide a
 * gesture that deletes nothing, or the human is back to `git worktree unlock` in a terminal — which is
 * exactly the state the refusal used to leave him in.
 *
 * The other thing pinned here is the FACTS: a release button on a row that does not first say how many
 * commits are inside and whether the tree is dirty cannot tell "clear the debris of a failed launch"
 * apart from "let go of somebody's unfinished work".
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { strings as fixtureStrings } from "../../scripts/webview-preview/fixtures/cockpit.js";
import { buildSectionsModel, type WorkspaceBundle, type WorktreeRow } from "@tachyon/webview-ui/sections/model";

const SHELL_TSX = path.join(__dirname, "../../packages/webview-ui/src/webview/worktrees/App.tsx");

/** What the classifier reports for the owner's measured state: clean, no commits, quarantined. */
const LOCKED_CLEAN = {
  state: "needs-review" as const,
  reasons: ["held by a Git worktree lock (added with --lock) — an interrupted launch left its quarantine behind"],
  pathExists: true,
  dirty: false,
  aheadOfBase: 0,
  containedInBase: true,
  containedInTrunk: true,
  trunkRef: "main",
  lock: { reason: "added with --lock" },
};

function agentRow(over: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id: "mw-agent-grok",
    kind: "agent",
    path: "/cache/wt/h/grok",
    branch: "tachyon/grok",
    status: "active",
    agent: "grok",
    folder: "tachyon",
    wsHash: "h",
    tachyonCreatedBranch: true,
    ownerPresence: "present",
    classification: LOCKED_CLEAN,
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

describe("t-d29398 — the Worktrees tab and a checkout an interrupted launch quarantined", () => {
  let Shell: (props: unknown) => unknown;
  const posted: unknown[] = [];

  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  const render = (rows: WorktreeRow[]): string =>
    renderStatic(Shell({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle(rows)], { section: "worktrees", wsHash: "h" }),
      post: (action: unknown) => posted.push(action),
    }));

  it("offers Release lock on an agent's own checkout — the case the owner was stuck on", () => {
    const html = render([agentRow()]);
    expect(html).toContain(fixtureStrings.wtReleaseLock);
    expect(html).toContain(fixtureStrings.wtLockedTitle);
    // The hand-off sentence would send him to a door that erases the agent he is trying to launch.
    expect(html).not.toContain(fixtureStrings.wtAgentOwned);
    // And nothing here offers to delete the checkout: releasing is not removing.
    expect(html).not.toContain(fixtureStrings.wtRemoveCheckout);
  });

  it("says what is inside before offering the gesture", () => {
    const clean = render([agentRow()]);
    expect(clean).toContain(fixtureStrings.wtInsideLabel);
    expect(clean).toContain(fixtureStrings.wtInsideClean);

    const withWork = render([agentRow({
      classification: { ...LOCKED_CLEAN, dirty: true, aheadOfBase: 3, containedInTrunk: false, containedInBase: false },
    })]);
    expect(withWork).toContain(fixtureStrings.wtInsideDirty);
    expect(withWork).toContain(fixtureStrings.wtInsideCommits.replace("{0}", "3"));
  });

  it("keeps a quarantined row out of every batch selection", () => {
    // A locked checkout can never be part of a bulk cleanup: git refuses to remove it, and the point
    // of the group is that a human looks at it. No checkbox, and no Select all on the group.
    const html = render([agentRow()]);
    expect(html).not.toContain('aria-label="grok"');
    const groupChunk = html.slice(html.indexOf(fixtureStrings.wtLockedTitle), html.indexOf(fixtureStrings.wtReleaseLock));
    expect(groupChunk).not.toContain(fixtureStrings.wtSelectAll);
  });

  it("leaves an unlocked row exactly as it was", () => {
    const html = render([agentRow({
      classification: { ...LOCKED_CLEAN, state: "ready-to-remove", reasons: [], lock: undefined },
    })]);
    expect(html).not.toContain(fixtureStrings.wtReleaseLock);
    expect(html).not.toContain(fixtureStrings.wtLockedTitle);
    expect(html).toContain(fixtureStrings.wtAgentOwned);
  });

  it("still defers to the live agent when one occupies the checkout", () => {
    // Occupancy wins over the lock: there the quarantine may belong to a launch in flight, and the
    // thing to do is deal with the agent. The engine refuses the release for the same reason.
    const html = render([agentRow({
      classification: {
        ...LOCKED_CLEAN,
        state: "occupied",
        occupant: { state: "live", agent: "grok", cwd: "/cache/wt/h/grok" },
        reasons: ["occupied by 'grok' (live)"],
      },
    })]);
    expect(html).not.toContain(fixtureStrings.wtReleaseLock);
    expect(html).toContain(fixtureStrings.wtOccupiedTitle);
  });
});
