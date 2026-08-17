/**
 * t-580570 — the agent door of `worktree.review` must resolve its base the same way the land
 * door already does (`localTrunkRef`), while still answering a WORKING-TREE comparison.
 *
 * Saved-agent `baseRef` is a birth fact and goes stale. Comparing against it shows the whole
 * trunk history since birth (measured on the host: 3,723 files against a 30-July SHA). Temporary
 * agents do not hit this because they are born with a fresh baseRef each spawn.
 *
 * Two independent questions — do not collapse them:
 *   · WHICH base — land already prefers the local trunk (`localTrunkRef(trunkRefs) ?? birth`)
 *   · AGAINST WHAT — land is committed (`base..head`); the agent door is the working tree
 *     (status + `changedFiles(path, base)` with no head, so untracked work is visible)
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { executeExtensionQuery } from "@tachyon/engine/engine-service/extensionOperationService.js";
import { WorktreeManager } from "@tachyon/engine/worktree/WorktreeManager.js";
import { makeTempDir } from "../helpers/tempDir.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Primary checkout on `main`, fossil birth SHA, then trunk advanced with a file the agent never touched. */
function savedAgentRepo(): {
  repo: string;
  worktreePath: string;
  fossil: string;
  trunk: string;
} {
  const repo = makeTempDir("wt-review-base-");
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "T"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "birth\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "birth"], repo);
  const fossil = git(["rev-parse", "HEAD"], repo);

  fs.writeFileSync(path.join(repo, "main-only.txt"), "landed on trunk after the agent was born\n");
  git(["add", "main-only.txt"], repo);
  git(["commit", "-q", "-m", "advance trunk"], repo);
  const trunk = git(["rev-parse", "HEAD"], repo);

  const worktreePath = path.join(makeTempDir("wt-review-agent-"), "saved");
  git(["worktree", "add", "-q", "-b", "tachyon/saved", worktreePath, "main"], repo);
  fs.writeFileSync(path.join(worktreePath, "wip.txt"), "uncommitted agent work\n");

  return { repo, worktreePath, fossil, trunk };
}

describe("t-580570 — agent worktree.review resolves trunk, keeps working-tree comparison", () => {
  it("opens review for a saved agent whose baseRef is behind trunk and uses the trunk, not the fossil", async () => {
    const { repo, worktreePath, fossil, trunk } = savedAgentRepo();
    expect(fossil).not.toBe(trunk);

    const manager = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => ({ worktree: { base: path.dirname(worktreePath) } }),
    });

    const basesUsed: string[] = [];
    const payload = await executeExtensionQuery(
      {
        workspace: {
          workspaceRoot: repo,
          ledger: {
            get: () => ({
              worktree: {
                path: worktreePath,
                branch: "tachyon/saved",
                tachyonCreatedBranch: true,
                baseRef: fossil,
                createdAt: "2026-07-30T00:00:00.000Z",
              },
            }),
          },
          worktrees: {
            status: async (cwd: string, baseRef: string) => {
              basesUsed.push(`status:${baseRef}`);
              return manager.status(cwd, baseRef);
            },
            changedFiles: async (cwd: string, baseRef: string, headRef?: string) => {
              basesUsed.push(headRef ? `committed:${baseRef}..${headRef}` : `working-tree:${baseRef}`);
              return manager.changedFiles(cwd, baseRef, headRef);
            },
          },
        } as never,
      },
      { action: "worktree.review", agent: "saved" },
    );

    const review = payload as {
      record: { baseRef: string } | null;
      status: object | null;
      changedFiles: Array<{ status: string; path: string }>;
      comparison?: { base?: string; head?: string };
    };

    // The birth SHA stays on the record — it is a fact of birth, not the comparison.
    expect(review.record?.baseRef).toBe(fossil);

    // WHICH base: the one handed to git, and the one named on the answer, is the local trunk.
    expect(basesUsed).toContain("working-tree:main");
    expect(basesUsed).toContain("status:main");
    expect(basesUsed.some((entry) => entry.includes(fossil))).toBe(false);
    expect(review.comparison).toEqual({ base: "main" });

    // AGAINST WHAT: still the working tree. A committed comparison would drop the untracked
    // file and would have recorded a `committed:` call above.
    expect(basesUsed.some((entry) => entry.startsWith("committed:"))).toBe(false);
    expect(review.status).not.toBeNull();
    expect(review.comparison).not.toHaveProperty("head");
    expect(review.changedFiles).toEqual([{ status: "A", path: "wip.txt" }]);
  });

  it("does not unify the doors: the agent path still has no head, and the surface reads comparison.base", () => {
    const producer = fs.readFileSync(
      path.join(process.cwd(), "packages/engine/src/engine-service/extensionOperationService.ts"),
      "utf8",
    );
    const consumer = fs.readFileSync(
      path.join(process.cwd(), "apps/vscode-extension/src/extension.ts"),
      "utf8",
    );
    // The land door stays on its own function; this change must not fold the identities together.
    expect(producer).toContain('if ("worktreeId" in query) return inspectWorktreeForLanding(workspace, query.worktreeId)');
    // Working-tree comparison: changedFiles is called with (path, base) and no head.
    expect(producer).toMatch(/workspace\.worktrees\.changedFiles\(record\.path, base\)/);
    expect(producer).not.toMatch(/workspace\.worktrees\.changedFiles\(record\.path, base,/);
    // The surface that opens the diff must use the resolved base, not the birth SHA.
    expect(consumer).toContain("review.comparison?.base ?? review.record.baseRef");
  });
});
