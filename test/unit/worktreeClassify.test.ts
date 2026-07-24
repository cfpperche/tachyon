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
    expect(result).toEqual({ state: "record-only", reasons: ["path does not exist"], pathExists: false, dirty: false, aheadOfBase: 0, containedInBase: false });
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
    expect(result.reasons).toEqual(["worktree has uncommitted changes"]);
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
    expect(result.reasons).toEqual(["1 commit(s) not contained in base"]);
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
    expect(result.reasons).toEqual(["occupied by 'codex' (live)"]);
  });

  it("t-9f8dfc: a failed status probe fails closed to needs-review, never ready-to-remove", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => { throw new Error("git binary missing"); } }),
    );
    expect(result.state).toBe("needs-review");
    expect(result.dirty).toBe(true);
    expect(result.containedInBase).toBe(false);
    expect(result.reasons).toEqual(["git status probe failed — treated as unsafe"]);
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
    expect(result.reasons).toEqual(["base ref 'main' could not be resolved — ancestry unknown, treated as unsafe"]);
  });

  it("t-9f8dfc blocker fix: aheadProbeFailed plus real uncommitted changes reports both reasons", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => ({ ...cleanStatus(0), aheadProbeFailed: true, unstaged: 3 }) }),
    );
    expect(result.state).toBe("needs-review");
    expect(result.reasons).toEqual([
      "base ref 'main' could not be resolved — ancestry unknown, treated as unsafe",
      "worktree has uncommitted changes",
    ]);
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
