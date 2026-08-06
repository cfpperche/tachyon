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
      (name) => ({ path: `/wt/${name}`, branch: `tachyon/${name}`, baseRef: "base-sha" }),
      { changedFiles: async (cwd) => filesByAgent[cwd.split("/").pop()!] ?? [] },
    );
    expect(rows).toEqual([
      { agent: "alice", worktree: true, branch: "tachyon/alice", baseRef: "base-sha", files: filesByAgent.alice },
      { agent: "bob", worktree: true, branch: "tachyon/bob", baseRef: "base-sha", files: filesByAgent.bob },
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

  it("an agent with no isolated worktree is reported honestly, never folded into 'touched nothing'", async () => {
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
        note: "no isolated worktree — this agent shares a checkout, so its touched files cannot be derived from a branch diff",
      },
    ]);
  });
});
