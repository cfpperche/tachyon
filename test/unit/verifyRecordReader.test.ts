import { describe, expect, it, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isVerifiedSince, readVerificationRecord } from "../../src/workspace/verifyRecordReader.js";

const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function repo(): { dir: string; tree: string; commonDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-verify-reader-"));
  roots.push(dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-C", dir, "add", "a.txt"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-qm", "one"], { stdio: "ignore", env });
  const tree = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const commonDir = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  return { dir, tree, commonDir };
}

function writeRecord(commonDir: string, tree: string, body: Record<string, unknown>): void {
  const dir = path.join(commonDir, "tachyon-verify");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${tree}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

describe("verification record reader (t-5e9bf8)", () => {
  it("reads a record filed for the tree at HEAD", () => {
    const { dir, tree, commonDir } = repo();
    writeRecord(commonDir, tree, { schema: 2, tree, commit: "x", at: "2026-07-02T00:00:00.000Z", summary: "619 files" });
    expect(readVerificationRecord(dir, "HEAD")).toMatchObject({ tree, at: "2026-07-02T00:00:00.000Z", summary: "619 files" });
  });

  it("answers the since question on both sides of the cutoff", () => {
    const { dir, tree, commonDir } = repo();
    writeRecord(commonDir, tree, { schema: 2, tree, at: "2026-07-02T00:00:00.000Z" });
    expect(isVerifiedSince(dir, "HEAD", "2026-07-01T00:00:00.000Z")).toBe(true);
    // A green recorded BEFORE the task was assigned is evidence about earlier work, not this task.
    expect(isVerifiedSince(dir, "HEAD", "2026-07-03T00:00:00.000Z")).toBe(false);
  });

  it("fails closed on absent, mismatched, malformed and unparseable records", () => {
    const { dir, tree, commonDir } = repo();
    const since = "2026-07-01T00:00:00.000Z";
    expect(isVerifiedSince(dir, "HEAD", since), "absent").toBe(false);

    // A record whose `tree` disagrees with its own filename proves nothing about that tree.
    writeRecord(commonDir, tree, { schema: 2, tree: "f".repeat(40), at: "2026-07-02T00:00:00.000Z" });
    expect(isVerifiedSince(dir, "HEAD", since), "mismatched tree").toBe(false);

    writeRecord(commonDir, tree, { schema: 2, tree, at: "not-a-date" });
    expect(isVerifiedSince(dir, "HEAD", since), "unparseable timestamp").toBe(false);

    // An unknown schema is not a record this reader understands.
    writeRecord(commonDir, tree, { schema: 99, tree, at: "2026-07-02T00:00:00.000Z" });
    expect(isVerifiedSince(dir, "HEAD", since), "unknown schema").toBe(false);

    fs.writeFileSync(path.join(commonDir, "tachyon-verify", `${tree}.json`), "{ not json");
    expect(isVerifiedSince(dir, "HEAD", since), "malformed json").toBe(false);

    expect(isVerifiedSince("/definitely/not/a/repo", "HEAD", since), "not a repo").toBe(false);
  });

  it("a LINKED worktree reads the record its own gate wrote, because the dir is git-common", () => {
    // This is the property the whole signal depends on: the agent runs the gate in its worktree, the
    // host reads the record from the primary checkout.
    const { dir, commonDir } = repo();
    const linked = path.join(dir, "..", `${path.basename(dir)}-wt`);
    roots.push(linked);
    execFileSync("git", ["-C", dir, "worktree", "add", "-q", "-b", "side", linked], { stdio: "ignore" });
    const linkedTree = execFileSync("git", ["-C", linked, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    writeRecord(commonDir, linkedTree, { schema: 2, tree: linkedTree, at: "2026-07-02T00:00:00.000Z" });

    expect(isVerifiedSince(linked, "HEAD", "2026-07-01T00:00:00.000Z"), "from the worktree").toBe(true);
    expect(isVerifiedSince(dir, "HEAD", "2026-07-01T00:00:00.000Z"), "from the primary checkout").toBe(true);
  });
});
