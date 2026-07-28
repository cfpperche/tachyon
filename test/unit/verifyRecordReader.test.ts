import { describe, expect, it } from "vitest";
import { isVerifiedSince, readVerificationRecord } from "../../src/workspace/verifyRecordReader.js";
import type { GitExec } from "../../src/worktree/WorktreeManager.js";

const TREE = "a".repeat(40);
const COMMON = "/repo/.git";
const SINCE = "2026-07-01T00:00:00.000Z";

/**
 * A fake `GitExec` rather than a real repository: the reader must be async (the wedge invariant
 * forbids a blocking subprocess under `src`), and injecting the exec is what lets these cases —
 * including git FAILING — be stated directly.
 */
function git(over: { tree?: string | null; common?: string | null; code?: number } = {}): GitExec {
  return async (args: string[]) => {
    if (over.code) return { code: over.code, stdout: "", stderr: "" };
    if (args.includes("--git-common-dir")) {
      return over.common === null
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: `${over.common ?? COMMON}\n`, stderr: "" };
    }
    return over.tree === null
      ? { code: 1, stdout: "", stderr: "" }
      : { code: 0, stdout: `${over.tree ?? TREE}\n`, stderr: "" };
  };
}

const reader = (body: unknown, file = `${COMMON}/tachyon-verify/${TREE}.json`) => (asked: string) => {
  if (asked !== file) throw new Error(`ENOENT ${asked}`);
  return typeof body === "string" ? body : JSON.stringify(body);
};

describe("verification record reader (t-5e9bf8)", () => {
  it("reads the record filed for the tree at HEAD, from the git-common dir", async () => {
    // The path assertion IS the point: the common dir is shared by every worktree, which is how the
    // host reads a record the agent's own checkout wrote.
    const record = await readVerificationRecord("/wt/agent", "HEAD", git(), reader({
      schema: 2, tree: TREE, commit: "c", at: "2026-07-02T00:00:00.000Z", summary: "619 files",
    }));
    expect(record).toMatchObject({ tree: TREE, at: "2026-07-02T00:00:00.000Z", summary: "619 files" });
  });

  it("answers the since question on both sides of the cutoff", async () => {
    const read = reader({ schema: 2, tree: TREE, at: "2026-07-02T00:00:00.000Z" });
    await expect(isVerifiedSince("/wt/agent", "HEAD", SINCE, git(), read)).resolves.toBe(true);
    // A green recorded BEFORE the task was assigned is evidence about earlier work, not this task.
    await expect(isVerifiedSince("/wt/agent", "HEAD", "2026-07-03T00:00:00.000Z", git(), read)).resolves.toBe(false);
  });

  it("fails closed on every unreadable shape", async () => {
    const cases: Array<[string, () => Promise<boolean>]> = [
      ["absent record", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git(), () => { throw new Error("ENOENT"); })],
      ["malformed json", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git(), reader("{ not json"))],
      // A record whose `tree` disagrees with its own filename proves nothing about that tree.
      ["mismatched tree", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git(), reader({ schema: 2, tree: "f".repeat(40), at: "2026-07-02T00:00:00.000Z" }))],
      ["unknown schema", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git(), reader({ schema: 99, tree: TREE, at: "2026-07-02T00:00:00.000Z" }))],
      ["unparseable at", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git(), reader({ schema: 2, tree: TREE, at: "nope" }))],
      ["missing at", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git(), reader({ schema: 2, tree: TREE }))],
      ["unparseable since", () => isVerifiedSince("/wt/a", "HEAD", "nope", git(), reader({ schema: 2, tree: TREE, at: "2026-07-02T00:00:00.000Z" }))],
      ["git rev-parse fails", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ tree: null }), reader({ schema: 2, tree: TREE, at: "2026-07-02T00:00:00.000Z" }))],
      ["common-dir lookup fails", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ common: null }), reader({ schema: 2, tree: TREE, at: "2026-07-02T00:00:00.000Z" }))],
      ["git unavailable", () => isVerifiedSince("/wt/a", "HEAD", SINCE, async () => { throw new Error("no git"); }, reader({ schema: 2, tree: TREE, at: "2026-07-02T00:00:00.000Z" }))],
      ["non-sha tree output", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ tree: "not-a-sha" }), reader({ schema: 2, tree: TREE, at: "2026-07-02T00:00:00.000Z" }))],
    ];
    for (const [label, run] of cases) {
      await expect(run(), label).resolves.toBe(false);
    }
  });
});
