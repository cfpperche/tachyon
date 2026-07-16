import { describe, expect, it } from "vitest";
import { classifyDelivery, containedInBase, hygieneReport } from "../../src/git-delivery/classify.js";
import type { GitDelivery } from "../../src/git-delivery/types.js";
import type { GitExec, GitResult } from "../../src/worktree/WorktreeManager.js";

const actor = { kind: "agent" as const, name: "owner" };

function baseDelivery(overrides: Partial<GitDelivery> = {}): GitDelivery {
  return {
    schemaVersion: 1,
    id: "gd-a1",
    deliveryId: "d-a1",
    version: 1,
    workspaceId: "ws",
    createdBy: actor,
    agent: "worker",
    branchRef: "tachyon/worker",
    worktreePath: "/wt/worker",
    tachyonCreatedBranch: true,
    baseRef: "main",
    currentHeadSha: "tip",
    phase: "open",
    taskLinks: [],
    transitions: [],
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = ""): GitResult => ({ code: 1, stdout: "", stderr });

function git(script: Record<string, GitResult>): GitExec {
  return async (args) => {
    const key = args.join(" ");
    return script[key] ?? script["*"] ?? fail(`unexpected git: ${key}`);
  };
}

describe("container-generated delegation behavior", () => {
  it("hygiene stays quiet about pruned rows and explains a cherry-picked delivery instead of calling it un-integrated", async () => {
    // (a) a phase="pruned" row with branch + worktree missing -> no missing_ref finding
    const prunedRow = baseDelivery({ id: "gd-pruned", phase: "pruned", branchRef: "gone-branch", worktreePath: "/wt/gone" });
    const prunedReport = await hygieneReport([prunedRow], [], {
      workspaceRoot: "/repo",
      git: git({ "*": fail() }),
      liveness: async () => "not_live",
    });
    expect(prunedReport.findings.filter((f) => f.deliveryId === "gd-pruned").map((f) => f.category)).not.toContain("missing_ref");

    // (b) an OPEN row with a genuinely missing branch -> missing_ref still emitted; the signal survives
    const openMissingRow = baseDelivery({ id: "gd-open-missing", phase: "open", branchRef: "gone-branch-2", worktreePath: "/wt/gone-2" });
    const openReport = await hygieneReport([openMissingRow], [], {
      workspaceRoot: "/repo",
      git: git({ "*": fail() }),
      liveness: async () => "not_live",
    });
    expect(openReport.findings.filter((f) => f.deliveryId === "gd-open-missing").map((f) => f.category)).toContain("missing_ref");

    // (c) no integration metadata, tip is not an ancestor, but `git cherry` shows only '-' lines -> softer reason/category,
    // and containedInBase() still returns FALSE (it is the data-loss guard; patch-equivalence alone must not flip it)
    const cherryPickedRow = baseDelivery({ id: "gd-cherry", branchRef: "tachyon/cherry", worktreePath: "/wt/cherry", currentHeadSha: "cherry-tip" });
    const cherryGit = git({
      "show-ref --verify --quiet refs/heads/tachyon/cherry": ok(),
      "rev-parse tachyon/cherry": ok("cherry-tip\n"),
      "status --porcelain=v1 --untracked-files=all": ok(""),
      "merge-base --is-ancestor cherry-tip main": fail(),
      "cherry main cherry-tip": ok("-abc123 already in base\n"),
    });
    await expect(containedInBase(cherryPickedRow, "cherry-tip", { workspaceRoot: "/repo", git: cherryGit })).resolves.toBe(false);
    const cherryClassified = await classifyDelivery(cherryPickedRow, { workspaceRoot: "/repo", git: cherryGit, liveness: async () => "not_live" });
    expect(cherryClassified.containedInBase).toBe(false);
    expect(cherryClassified.reasons).toContain(
      "not an ancestor of base, but every patch is already in base (likely cherry-picked without integration metadata)",
    );
    expect(cherryClassified.reasons).not.toContain("branch tip is not contained in base");
    const cherryReport = await hygieneReport([cherryPickedRow], [], { workspaceRoot: "/repo", git: cherryGit, liveness: async () => "not_live" });
    expect(cherryReport.findings.some((f) => f.deliveryId === "gd-cherry" && f.category === "cherry_pick_unrecorded")).toBe(true);

    // (d) no integration metadata, tip has genuinely unmerged commits (`git cherry` shows a '+' line) -> the original hard reason stands
    const unmergedRow = baseDelivery({ id: "gd-unmerged", branchRef: "tachyon/unmerged", worktreePath: "/wt/unmerged", currentHeadSha: "unmerged-tip" });
    const unmergedGit = git({
      "show-ref --verify --quiet refs/heads/tachyon/unmerged": ok(),
      "rev-parse tachyon/unmerged": ok("unmerged-tip\n"),
      "status --porcelain=v1 --untracked-files=all": ok(""),
      "merge-base --is-ancestor unmerged-tip main": fail(),
      "cherry main unmerged-tip": ok("+def456 not yet in base\n"),
    });
    const unmergedClassified = await classifyDelivery(unmergedRow, { workspaceRoot: "/repo", git: unmergedGit, liveness: async () => "not_live" });
    expect(unmergedClassified.containedInBase).toBe(false);
    expect(unmergedClassified.reasons).toContain("branch tip is not contained in base");
  });
});
