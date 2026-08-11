import { describe, expect, it } from "vitest";
import {
  LAND_CHECK_ORDER,
  landSuggestion,
  probeLandSuggestion,
  probePrimaryCheckout,
  resolvePrimaryCheckout,
  type LandCheckId,
  type LandFacts,
} from "../../src/worktree/land.js";
import type { GitExec } from "../../src/worktree/WorktreeManager.js";

const HEAD = "9f3c1ab27d5e408b6c1d90ffae2b7c1d4e88a021";
const TREE = "41d0c7a9be2201fe3b6c8d47a05e91cc73b2f8de";

/** Every precondition proved. Each case below breaks exactly one of them. */
const READY: LandFacts = {
  head: HEAD,
  branch: "tachyon/change/fleet-ui",
  trunkRef: "main",
  primaryPath: "/home/goat/tachyon",
  dirty: false,
  commits: 2,
  verified: { tree: TREE, at: "2026-08-07T16:41:09.220Z" },
  trunkIsAncestorOfHead: true,
  trunkHead: null,
  primaryBranch: "main",
  primaryDirty: false,
};

const checkOf = (facts: LandFacts, id: LandCheckId) => landSuggestion(facts).checks.find((c) => c.id === id)!;

describe("landSuggestion", () => {
  it("offers the command only when every precondition is proved, and names the commit not the branch", () => {
    const out = landSuggestion(READY);
    expect(out.checks.map((c) => c.id)).toEqual([...LAND_CHECK_ORDER]);
    expect(out.checks.every((c) => c.ok)).toBe(true);
    expect(out.command).toBe(`git -C /home/goat/tachyon merge --ff-only ${HEAD}`);
    // The whole point of pinning the sha: the branch name must not be what gets landed.
    expect(out.command).not.toContain(READY.branch);
  });

  it("every green check states what proved it", () => {
    for (const check of landSuggestion(READY).checks) {
      expect(check.detail.length).toBeGreaterThan(0);
      expect(check.fix).toBeUndefined();
    }
    expect(checkOf(READY, "verified-tree").detail).toContain(TREE.slice(0, 12));
    expect(checkOf(READY, "fast-forward").detail).toContain("main");
  });

  /**
   * The table IS the claim: one blocked precondition is enough to withhold the command, and each
   * refusal names its own condition rather than a generic "not ready". Written as actor × trigger over
   * the five doors so a sixth precondition added later is visibly uncovered here.
   */
  const BLOCKED: Array<[string, LandCheckId, Partial<LandFacts>, string]> = [
    ["uncommitted changes in the delivering worktree", "worktree-clean", { dirty: true }, "uncommitted"],
    ["no verify record for the tree", "verified-tree", { verified: null }, "no verify record"],
    ["the trunk moved past this branch", "fast-forward", { trunkIsAncestorOfHead: false }, "has moved past"],
    ["ancestry could not be measured", "fast-forward", { trunkIsAncestorOfHead: null }, "could not be measured"],
    ["no local trunk to fast-forward", "fast-forward", { trunkRef: null }, "no local trunk"],
    ["the primary checkout is on another branch", "primary-on-trunk", { primaryBranch: "tachyon/change/x" }, "not 'main'"],
    ["the primary checkout is detached", "primary-on-trunk", { primaryBranch: null }, "detached"],
    ["the primary checkout could not be located", "primary-on-trunk", { primaryPath: null }, "could not be located"],
    ["the primary checkout is dirty", "primary-clean", { primaryDirty: true }, "the primary checkout has uncommitted changes"],
    ["primary cleanliness unmeasured", "primary-clean", { primaryDirty: null }, "could not be measured"],
  ];

  it.each(BLOCKED)("refuses when %s", (_name, id, override, phrase) => {
    const facts = { ...READY, ...override };
    const out = landSuggestion(facts);
    expect(out.command).toBeUndefined();
    const check = out.checks.find((c) => c.id === id)!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(phrase);
    // A refusal without a reachable exit is a dead end; the human is left where they started.
    expect(check.fix && check.fix.length > 0).toBe(true);
  });

  it("withholds the command when there is no HEAD at all, without claiming a condition failed", () => {
    const out = landSuggestion({ ...READY, head: null, verified: null });
    expect(out.command).toBeUndefined();
    expect(out.checks.find((c) => c.id === "verified-tree")!.detail).toBe("no commit to attest");
  });

  it("does not consider occupancy: an agent still live in its checkout can still be landed", () => {
    // There is deliberately no occupancy input. This asserts the shape rather than a value, because
    // the defect it prevents is someone ADDING one and refusing every ordinary delivery.
    expect(Object.keys(READY)).not.toContain("occupant");
    expect(landSuggestion(READY).command).toBeDefined();
  });
});

/** A git that answers by argument list, so a case can make one probe fail without touching the rest. */
function git(over: Record<string, { code?: number; stdout?: string }> = {}): GitExec {
  return async (args: string[], cwd: string) => {
    const key = args[0] === "cat-file" ? "record"
      : args[0] === "rev-parse" && args.includes("--git-common-dir") ? "common-dir"
      : args[0] === "rev-parse" && args.includes("--abbrev-ref") ? (cwd === "/wt" ? "branch" : "primary-branch")
        : args[0] === "rev-parse" && args[1] === `${HEAD}^{tree}` ? "tree"
          : args[0] === "rev-parse" ? "head"
            : args[0] === "merge-base" ? "ancestor"
              : args[0] === "status" ? "primary-status" : args[0];
    const answer = over[key];
    if (answer) return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: "" };
    const defaults: Record<string, string> = {
      "common-dir": "/repo/.git",
      head: HEAD,
      tree: TREE,
      record: JSON.stringify({ schema: 2, tree: TREE, at: new Date().toISOString(), fingerprint: "f".repeat(64) }),
      branch: "tachyon/change/fleet-ui",
      "primary-branch": "main",
      ancestor: "",
      "primary-status": "",
    };
    return { code: 0, stdout: defaults[key] ?? "", stderr: "" };
  };
}

const fingerprint = "f".repeat(64);
const currentRecord = () => JSON.stringify({
  schema: 2,
  tree: TREE,
  at: new Date().toISOString(),
  fingerprint,
});

async function expectVerificationRecordToBlockLanding(recordBody: Record<string, unknown>): Promise<void> {
  const out = await probeLandSuggestion({
    git: git({ record: { stdout: JSON.stringify(recordBody) } }), worktreePath: "/wt", trunkRef: "main", dirty: false, commits: 2,
  });
  expect(out.checks.find((c) => c.id === "verified-tree")!.ok).toBe(false);
  expect(out.command).toBeUndefined();
}

describe("probeLandSuggestion", () => {
  it("composes a ready suggestion from live probes, reusing the tree verification record", async () => {
    const out = await probeLandSuggestion({
      git: git(), worktreePath: "/wt", trunkRef: "main", dirty: false, commits: 2, readFile: currentRecord,
    });
    expect(out.primaryPath).toBe("/repo");
    expect(out.command).toBe(`git -C /repo merge --ff-only ${HEAD}`);
    expect(out.checks.find((c) => c.id === "verified-tree")!.ok).toBe(true);
  });

  it("reads exit 1 from merge-base as 'not an ancestor' and any other exit as 'not measured'", async () => {
    const notAncestor = await probeLandSuggestion({
      git: git({ ancestor: { code: 1 } }), worktreePath: "/wt", trunkRef: "main", dirty: false, commits: 2, readFile: currentRecord,
    });
    // SDD 498 D6 — when the trunk head is readable the refusal names WHERE it moved to, because that is
    // the operator's next question; it falls back to "has moved past" only when it is not.
    expect(notAncestor.checks.find((c) => c.id === "fast-forward")!.detail).toMatch(/has moved to [0-9a-f]{12}|has moved past/);
    expect(notAncestor.checks.find((c) => c.id === "fast-forward")!.detail).toContain("no longer contained in");
    const broken = await probeLandSuggestion({
      git: git({ ancestor: { code: 128 } }), worktreePath: "/wt", trunkRef: "main", dirty: false, commits: 2, readFile: currentRecord,
    });
    expect(broken.checks.find((c) => c.id === "fast-forward")!.detail).toContain("could not be measured");
  });

  it("treats a detached primary checkout as unknown rather than as a branch named HEAD", async () => {
    const out = await probeLandSuggestion({
      git: git({ "primary-branch": { stdout: "HEAD" } }), worktreePath: "/wt", trunkRef: "main", dirty: false, commits: 1, readFile: currentRecord,
    });
    expect(out.checks.find((c) => c.id === "primary-on-trunk")!.detail).toContain("detached");
  });

  it("refuses rather than guessing when the repository topology is not a plain clone", async () => {
    const out = await probeLandSuggestion({
      git: git({ "common-dir": { stdout: "/somewhere/else" } }), worktreePath: "/wt", trunkRef: "main", dirty: false, commits: 1, readFile: currentRecord,
    });
    expect(out.primaryPath).toBeNull();
    expect(out.command).toBeUndefined();
  });

  it("an absent verification record blocks the landing instead of being skipped", async () => {
    const out = await probeLandSuggestion({
      git: git({ record: { code: 1 } }), worktreePath: "/wt", trunkRef: "main", dirty: false, commits: 2,
    });
    expect(out.command).toBeUndefined();
    expect(out.checks.find((c) => c.id === "verified-tree")!.ok).toBe(false);
  });

  it("blocks a verification record that is thirty days old", async () => {
    await expectVerificationRecordToBlockLanding({
      schema: 2, tree: TREE, at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), fingerprint,
    });
  });

  it("blocks a verification record dated in the future", async () => {
    await expectVerificationRecordToBlockLanding({
      schema: 2, tree: TREE, at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), fingerprint,
    });
  });

  it("blocks a schema-1 verification record", async () => {
    await expectVerificationRecordToBlockLanding({
      schema: 1, tree: TREE, at: new Date().toISOString(),
    });
  });

  it("blocks a schema-2 verification record without a fingerprint", async () => {
    await expectVerificationRecordToBlockLanding({
      schema: 2, tree: TREE, at: new Date().toISOString(),
    });
  });
});

describe("probePrimaryCheckout", () => {
  it("is asked once and reused, so a sweep pays three subprocesses instead of three per row", async () => {
    const calls: string[][] = [];
    const counting: GitExec = async (args, cwd) => { calls.push(args); return git()(args, cwd); };
    const primary = await probePrimaryCheckout(counting, "/wt");
    expect(primary).toEqual({ path: "/repo", branch: "main", dirty: false });

    const before = calls.length;
    for (const worktreePath of ["/wt", "/wt2", "/wt3"]) {
      await probeLandSuggestion({ git: counting, worktreePath, trunkRef: "main", primary, dirty: false, commits: 1, readFile: currentRecord });
    }
    // Three rows, and not one of them re-read the primary checkout's branch or status.
    expect(calls.slice(before).filter((a) => a[0] === "status")).toEqual([]);
    expect(calls.slice(before).filter((a) => a[0] === "cat-file").length).toBe(3); // the record reader's own, per worktree
  });

  it("a detached primary is unknown, not a branch named HEAD", async () => {
    await expect(probePrimaryCheckout(git({ "primary-branch": { stdout: "HEAD" } }), "/wt"))
      .resolves.toMatchObject({ branch: null });
  });
});

describe("resolvePrimaryCheckout", () => {
  it("is the parent of the shared git dir, which every worktree of a clone resolves to the same path", async () => {
    await expect(resolvePrimaryCheckout(git(), "/wt")).resolves.toBe("/repo");
  });

  it("answers null when git cannot say", async () => {
    await expect(resolvePrimaryCheckout(git({ "common-dir": { code: 1 } }), "/wt")).resolves.toBeNull();
  });
});
