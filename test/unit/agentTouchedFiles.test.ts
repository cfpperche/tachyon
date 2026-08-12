import { describe, it, expect } from "vitest";
import { collectAgentTouchedFiles } from "../../src/worktree/agentTouchedFiles.js";
import type { ChangedFile } from "../../src/worktree/review.js";

describe("collectAgentTouchedFiles (t-75e9c7)", () => {
  it("reports files per live agent, from the diff of its own worktree", async () => {
    const filesByAgent: Record<string, ChangedFile[]> = {
      alice: [{ status: "M", path: "src/a.ts" }],
      bob: [{ status: "A", path: "src/b.ts" }],
    };
    const rows = await collectAgentTouchedFiles(
      [
        { name: "alice", running: true },
        { name: "bob", running: true },
      ],
      (name) => ({ path: `/wt/${name}`, branch: `tachyon/${name}`, baseRef: "base-sha", baseBranch: "main" }),
      {
        changedFiles: async (cwd) => filesByAgent[cwd.split("/").pop()!] ?? [],
        mergeBase: async () => "base-sha",
      },
    );
    expect(rows).toEqual([
      { agent: "alice", worktree: true, branch: "tachyon/alice", baseRef: "base-sha", baseBranch: "main", comparisonRef: "base-sha", files: filesByAgent.alice },
      { agent: "bob", worktree: true, branch: "tachyon/bob", baseRef: "base-sha", baseBranch: "main", comparisonRef: "base-sha", files: filesByAgent.bob },
    ]);
  });

  it("excludes an agent that is not running — dead is not live", async () => {
    const rows = await collectAgentTouchedFiles(
      [{ name: "gone", running: false }],
      () => ({ path: "/wt/gone", branch: "tachyon/gone", baseRef: "base" }),
      { changedFiles: async () => [{ status: "M", path: "should-not-appear.ts" }] },
    );
    expect(rows).toEqual([]);
  });

  it("an agent with no separate worktree is reported honestly, never folded into 'touched nothing'", async () => {
    const rows = await collectAgentTouchedFiles(
      [{ name: "shared", running: true }],
      () => undefined,
      { changedFiles: async () => { throw new Error("must not be called — no worktree to diff"); } },
    );
    expect(rows).toEqual([
      {
        agent: "shared",
        worktree: false,
        files: [],
        note: "no separate worktree — this agent shares a checkout, so its touched files cannot be derived from a branch diff",
      },
    ]);
  });

  it("qualifies a legacy worktree when its current base branch cannot be measured", async () => {
    const rows = await collectAgentTouchedFiles(
      [{ name: "legacy", running: true }],
      () => ({ path: "/wt/legacy", branch: "tachyon/legacy", baseRef: "old-base" }),
      { changedFiles: async () => [{ status: "M", path: "possibly-drift.ts" }] },
    );
    expect(rows).toEqual([
      {
        agent: "legacy",
        worktree: true,
        branch: "tachyon/legacy",
        baseRef: "old-base",
        comparisonRef: "old-base",
        files: [{ status: "M", path: "possibly-drift.ts" }],
        note: "creation-base diff — this legacy worktree has no recorded base branch, so the files may include branch drift since the agent was created",
      },
    ]);
  });
});
