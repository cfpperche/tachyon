/**
 * spec 444 — classifyManagedWorktree() unit coverage. Fully faked deps (no real git/filesystem):
 * the function's whole job is composing injected signals, so the composition logic is what's
 * under test, not git itself (real-git paths are already covered by git-delivery's own suite,
 * whose `patchesAllInBase` this ports).
 */
import { describe, expect, it } from "vitest";
import { classifyManagedWorktree, type ClassifyWorktreeDeps } from "../../src/worktree/classify.js";
import type { ManagedWorktreeEntry } from "../../src/worktree/managedWorktree.js";
import type { GitExec, GitResult, WorktreeOccupancy, WorktreeStatus } from "../../src/worktree/WorktreeManager.js";

function entry(overrides: Partial<ManagedWorktreeEntry> = {}): ManagedWorktreeEntry {
  return {
    id: "mw-change-x",
    kind: "change",
    path: "/wt/x",
    branch: "tachyon/change/x",
    baseRef: "main",
    tachyonCreatedBranch: true,
    createdAt: "2026-07-24T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function cleanStatus(aheadOfBase = 0): WorktreeStatus {
  return { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, detached: false, branch: "tachyon/change/x", aheadOfBase, unpushed: aheadOfBase, hasUpstream: false };
}

function fakeGit(script: Record<string, GitResult | ((args: string[], cwd: string) => GitResult)>): GitExec {
  return async (args, cwd) => {
    const key = args.join(" ");
    const hit = script[key] ?? script["*"];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected git: ${key} @ ${cwd}` };
    return typeof hit === "function" ? hit(args, cwd) : hit;
  };
}

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

function deps(over: Partial<ClassifyWorktreeDeps> & { status: ClassifyWorktreeDeps["status"] }): ClassifyWorktreeDeps {
  return { pathExists: () => true, ...over };
}

describe("classifyManagedWorktree", () => {
  it("t-9f8dfc: a missing path classifies record-only without probing git at all", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ pathExists: () => false, status: async () => { throw new Error("must not be called"); } }),
    );
    // t-6ae9a8 added the trunk signals; the point of this case is unchanged — a missing path short-
    // circuits before any git probe, so neither containment signal can be anything but false.
    expect(result.state).toBe("record-only");
    expect(result.pathExists).toBe(false);
    expect(result.dirty).toBe(false);
    expect(result.aheadOfBase).toBe(0);
    expect(result.containedInBase).toBe(false);
    expect(result.containedInTrunk).toBe(false);
    expect(result.trunkRef).toBe("main");
    // t-dcdb7f — reason carries both the fact and a reachable registry exit.
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/path does not exist/);
    expect(result.reasons[0]).toMatch(/abandoned|host UI/);
  });

  it("t-9f8dfc: clean, unoccupied, zero-commits-ahead classifies ready-to-remove", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => cleanStatus(0) }),
    );
    expect(result.state).toBe("ready-to-remove");
    expect(result.reasons).toEqual([]);
    expect(result.dirty).toBe(false);
    expect(result.containedInBase).toBe(true);
  });

  it("t-9f8dfc: uncommitted changes classify needs-review with a dirty reason", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => ({ ...cleanStatus(0), unstaged: 2 }) }),
    );
    expect(result.state).toBe("needs-review");
    expect(result.dirty).toBe(true);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/uncommitted changes/);
  });

  it("t-9f8dfc: commits ahead that are NOT patch-equivalent in base classify needs-review", async () => {
    const git = fakeGit({
      "rev-parse HEAD": ok("deadbeef"),
      "cherry main deadbeef": ok("+ deadbeef some unique commit"),
    });
    const result = await classifyManagedWorktree(
      entry(),
      deps({ git, status: async () => cleanStatus(1) }),
    );
    expect(result.state).toBe("needs-review");
    expect(result.containedInBase).toBe(false);
    // t-6ae9a8 — the reason now names BOTH proofs, because either would have sufficed and neither held.
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/1 commit\(s\) not contained in base or in 'main'/);
  });

  it("t-9f8dfc: commits ahead that ARE fully patch-equivalent in base (cherry-picked/squashed) still classify ready-to-remove", async () => {
    const git = fakeGit({
      "rev-parse HEAD": ok("deadbeef"),
      "cherry main deadbeef": ok("- deadbeef already-integrated patch"),
    });
    const result = await classifyManagedWorktree(
      entry(),
      deps({ git, status: async () => cleanStatus(1) }),
    );
    expect(result.state).toBe("ready-to-remove");
    expect(result.containedInBase).toBe(true);
    expect(result.aheadOfBase).toBe(1);
  });

  it("t-9f8dfc: a live occupant always wins — occupied, even when also dirty and ahead", async () => {
    const occupant: WorktreeOccupancy = { state: "live", agent: "codex", cwd: "/wt/x" };
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => ({ ...cleanStatus(3), unstaged: 1 }), occupancy: async () => occupant }),
    );
    expect(result.state).toBe("occupied");
    expect(result.occupant).toEqual(occupant);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/occupied by 'codex' \(live\)/);
  });

  it("t-9f8dfc: a failed status probe fails closed to needs-review, never ready-to-remove", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => { throw new Error("git binary missing"); } }),
    );
    expect(result.state).toBe("needs-review");
    expect(result.dirty).toBe(true);
    expect(result.containedInBase).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/git status probe failed/);
  });

  it("t-9f8dfc blocker fix: status RESOLVING with aheadProbeFailed (unresolvable baseRef) also fails closed — the real WorktreeManager.status contract never rejects for this", async () => {
    // WorktreeManager.status best-effort-coerces a failed `rev-list baseRef..HEAD` to
    // aheadOfBase 0 and RESOLVES. Before the fix, 0 read as "contained" -> ready-to-remove for a
    // worktree of unknown ancestry (adversarial-review confirmed data-loss path).
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => ({ ...cleanStatus(0), aheadProbeFailed: true }) }),
    );
    expect(result.state).toBe("needs-review");
    expect(result.containedInBase).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/base ref 'main' could not be resolved/);
    expect(result.reasons[0]).toMatch(/ancestry unknown/);
  });

  it("t-9f8dfc blocker fix: aheadProbeFailed plus real uncommitted changes reports both reasons", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => ({ ...cleanStatus(0), aheadProbeFailed: true, unstaged: 3 }) }),
    );
    expect(result.state).toBe("needs-review");
    // t-6ae9a8 reordered these: uncommitted work now leads, because it is the more urgent and more
    // actionable of the two. Both are still reported, which is what this case is named for.
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toMatch(/uncommitted changes/);
    expect(result.reasons[1]).toMatch(/base ref 'main' could not be resolved/);
  });

  // ── t-d29398 — the Git lock, which no signal here used to measure ────────────────────────────
  it("t-d29398: a clean, contained, LOCKED checkout is not ready-to-remove — git refuses to remove it at all", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => cleanStatus(0), lockState: async () => ({ locked: true, reason: "added with --lock" }) }),
    );
    // Every other signal says safe. Before the lock was measured this classified ready-to-remove and
    // the surface offered a Remove button that `git worktree remove` refuses even with --force.
    expect(result.state).toBe("needs-review");
    expect(result.dirty).toBe(false);
    expect(result.aheadOfBase).toBe(0);
    expect(result.lock).toEqual({ reason: "added with --lock" });
    expect(result.reasons[0]).toMatch(/Git worktree lock \(added with --lock\)/);
    expect(result.reasons[0]).toMatch(/interrupted launch/);
  });

  it("t-d29398: the lock leads the reasons, because it blocks the exits the other reasons name", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => ({ ...cleanStatus(2), unstaged: 1 }), lockState: async () => ({ locked: true }) }),
    );
    expect(result.reasons).toHaveLength(3);
    expect(result.reasons[0]).toMatch(/Git worktree lock/);
    expect(result.reasons[1]).toMatch(/uncommitted changes/);
    // A human's own lock reads differently from Tachyon's quarantine: nothing claims to know why.
    expect(result.reasons[0]).not.toMatch(/interrupted launch/);
  });

  it("t-d29398: an unwired or failed lock probe changes nothing — it is never read as unlocked", async () => {
    const unwired = await classifyManagedWorktree(entry(), deps({ status: async () => cleanStatus(0) }));
    expect(unwired.state).toBe("ready-to-remove");
    expect(unwired.lock).toBeUndefined();

    // `undefined` from the probe means UNKNOWN. It costs the row nothing and claims nothing, exactly
    // like the occupancy probe below: the honest alternative — blocking every row whose lock could not
    // be measured — would refuse cleanup on any repository where `git worktree list` is unhappy.
    const threw = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => cleanStatus(0), lockState: async () => { throw new Error("git unavailable"); } }),
    );
    expect(threw.state).toBe("ready-to-remove");
    expect(threw.lock).toBeUndefined();
  });

  it("t-d29398: occupancy still wins — a live agent's lock may belong to a launch in flight", async () => {
    const occupant: WorktreeOccupancy = { state: "live", agent: "codex", cwd: "/wt/x" };
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => cleanStatus(0), occupancy: async () => occupant, lockState: async () => ({ locked: true }) }),
    );
    expect(result.state).toBe("occupied");
    expect(result.lock).toEqual({});
    expect(result.reasons[0]).toMatch(/occupied by 'codex'/);
  });

  it("t-9f8dfc: a failed occupancy probe does not crash classification (best-effort, treated as unoccupied)", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => cleanStatus(0), occupancy: async () => { throw new Error("probe unavailable"); } }),
    );
    expect(result.state).toBe("ready-to-remove");
    expect(result.occupant).toBeUndefined();
  });
});
