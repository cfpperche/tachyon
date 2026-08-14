import { describe, expect, it } from "vitest";
import { isVerifiedSince, readVerificationRecord } from "@tachyon/engine/workspace/verifyRecordReader.js";
import type { GitExec } from "@tachyon/engine/worktree/WorktreeManager.js";

const TREE = "a".repeat(40);
const SINCE = "2026-07-01T00:00:00.000Z";
const NOW = Date.parse("2026-07-03T00:00:00.000Z");
const FINGERPRINT = "f".repeat(64);

/**
 * A fake `GitExec` rather than a real repository: the reader must be async (the wedge invariant
 * forbids a blocking subprocess under `src`), and injecting the exec is what lets these cases —
 * including git FAILING — be stated directly.
 */
function git(over: { tree?: string | null; blob?: string | null; code?: number } = {}): GitExec {
  return async (args: string[]) => {
    if (over.code) return { code: over.code, stdout: "", stderr: "" };
    if (args[0] === "cat-file") {
      return over.blob === null
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: `${over.blob ?? ""}\n`, stderr: "" };
    }
    return over.tree === null
      ? { code: 1, stdout: "", stderr: "" }
      : { code: 0, stdout: `${over.tree ?? TREE}\n`, stderr: "" };
  };
}

const body = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

describe("verification record reader (t-5e9bf8)", () => {
  it("reads the record filed for the tree at HEAD through its git ref", async () => {
    const record = await readVerificationRecord("/wt/agent", "HEAD", git({ blob: body({
      schema: 2, tree: TREE, commit: "c", at: "2026-07-02T00:00:00.000Z", fingerprint: FINGERPRINT, summary: "619 files",
    }) }), undefined, () => NOW);
    expect(record).toMatchObject({ tree: TREE, at: "2026-07-02T00:00:00.000Z", summary: "619 files" });
  });

  it("answers the since question on both sides of the cutoff", async () => {
    const withRecord = git({ blob: body({ schema: 2, tree: TREE, at: "2026-07-02T00:00:00.000Z", fingerprint: FINGERPRINT }) });
    await expect(isVerifiedSince("/wt/agent", "HEAD", SINCE, withRecord, undefined, () => NOW)).resolves.toBe(true);
    // A green recorded BEFORE the task was assigned is evidence about earlier work, not this task.
    await expect(isVerifiedSince("/wt/agent", "HEAD", "2026-07-03T00:00:00.000Z", withRecord, undefined, () => NOW)).resolves.toBe(false);
  });

  it("fails closed on every unreadable shape", async () => {
    const cases: Array<[string, () => Promise<boolean>]> = [
      ["absent record", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ blob: null }))],
      ["malformed json", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ blob: "{ not json" }))],
      // A record whose `tree` disagrees with its own ref name proves nothing about that tree.
      ["mismatched tree", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ blob: body({ schema: 2, tree: "f".repeat(40), at: "2026-07-02T00:00:00.000Z" }) }))],
      ["unknown schema", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ blob: body({ schema: 99, tree: TREE, at: "2026-07-02T00:00:00.000Z" }) }))],
      ["unparseable at", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ blob: body({ schema: 2, tree: TREE, at: "nope" }) }))],
      ["missing at", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ blob: body({ schema: 2, tree: TREE }) }))],
      ["unparseable since", () => isVerifiedSince("/wt/a", "HEAD", "nope", git({ blob: body({ schema: 2, tree: TREE, at: "2026-07-02T00:00:00.000Z" }) }))],
      ["git rev-parse fails", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ tree: null }))],
      ["blob lookup fails", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ blob: null }))],
      ["git unavailable", () => isVerifiedSince("/wt/a", "HEAD", SINCE, async () => { throw new Error("no git"); })],
      ["non-sha tree output", () => isVerifiedSince("/wt/a", "HEAD", SINCE, git({ tree: "not-a-sha" }))],
    ];
    for (const [label, run] of cases) {
      await expect(run(), label).resolves.toBe(false);
    }
  });
});
