import { describe, expect, it, vi } from "vitest";
import { resolveParentLocation, type ParentLocationSources } from "../../src/worktree/parentLocation.js";

/**
 * t-c9da28 — the three states a parent can be in, which one `undefined` used to flatten.
 *
 * Measured shape of the defect: `parentCwd` read only the session ledger, so a retired row made a
 * parented child fall through to the workspace root with no notice — while the same code path
 * refused an explicit `cwd` from the caller specifically so nobody would be misled about where the
 * child runs.
 */
function sources(over: Partial<ParentLocationSources> = {}): ParentLocationSources {
  return {
    ledgerRow: () => undefined,
    managedWorktreePath: () => undefined,
    isLiveAgent: async () => false,
    ...over,
  };
}

describe("t-c9da28 — locating a parent, in descending order of authority", () => {
  it("uses the ledger's worktree path before anything else", async () => {
    const managedWorktreePath = vi.fn(() => "/never/consulted");
    const s = sources({
      ledgerRow: () => ({ cwd: "/root", worktreePath: "/wt/boss" }),
      managedWorktreePath,
    });

    expect(await resolveParentLocation(s)).toEqual({ cwd: "/wt/boss", known: true });
    // The cheap answer ends the search: no registry scan, and no session round-trip.
    expect(managedWorktreePath).not.toHaveBeenCalled();
  });

  it("falls to the ledger's plain cwd when it recorded no worktree", async () => {
    const s = sources({ ledgerRow: () => ({ cwd: "/repo" }) });

    expect(await resolveParentLocation(s)).toEqual({ cwd: "/repo", known: true });
  });

  it("RECOVERS from the worktree registry when the ledger row is gone", async () => {
    // The reaped-parent case. The registry recorded where this agent was actually put, so this is a
    // recovered fact, not a guess — and it is why the child still inherits instead of falling back.
    const s = sources({ managedWorktreePath: () => "/wt/boss" });

    expect(await resolveParentLocation(s)).toEqual({ cwd: "/wt/boss", known: true });
  });

  it("reports a row with no directory as known-but-unlocatable, never as absent", async () => {
    // Known is what keeps a restarted coordinator able to spawn: the child falls back to the root and
    // is TOLD, rather than being refused or moved silently.
    const s = sources({ ledgerRow: () => ({}) });

    expect(await resolveParentLocation(s)).toEqual({ known: true });
  });

  it("accepts a live session as proof for a parent no row was ever written for", async () => {
    const s = sources({ isLiveAgent: async () => true });

    expect(await resolveParentLocation(s)).toEqual({ known: true });
  });

  it("reports a parent nobody has heard of as unknown, so the caller can be refused", async () => {
    expect(await resolveParentLocation(sources())).toEqual({ known: false });
  });

  it("only pays for the live-session round-trip when every cheaper source is silent", async () => {
    const isLiveAgent = vi.fn(async () => true);

    await resolveParentLocation(sources({ ledgerRow: () => ({ cwd: "/repo" }), isLiveAgent }));
    expect(isLiveAgent).not.toHaveBeenCalled();

    await resolveParentLocation(sources({ managedWorktreePath: () => "/wt/boss", isLiveAgent }));
    expect(isLiveAgent).not.toHaveBeenCalled();

    await resolveParentLocation(sources({ isLiveAgent }));
    expect(isLiveAgent).toHaveBeenCalledTimes(1);
  });
});
