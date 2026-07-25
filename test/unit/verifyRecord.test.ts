import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
// The verification runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- exercising the real recorder the verify path uses is the point.
import { recordVerification, readRecord, verifiableTree, treeOf, recordDir } from "../../scripts/verify-record.mjs";

/**
 * t-47cc91 — the record answers "was THIS content verified?", which is what
 * docs/project-guidance.md § Landing order requires ("the tree you land must be the tree you
 * verified"). Before it, that rule could only be honoured from memory.
 *
 * The tests that matter are the REFUSALS: a record that appears for a dirty tree, or survives a red
 * run, is worse than no record — it is a proof of something that was never verified.
 */

function gitOk(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-record-test-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: ENV });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir, env: ENV });
  return dir;
}
const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

describe.skipIf(!gitOk())("verification record (t-47cc91)", () => {
  it("files a green under the tree it covered, and finds it again", () => {
    const cwd = repo();
    const r = recordVerification({ cwd, command: "verify:full", summary: "1 file" });
    expect(r.recorded).toBe(true);
    const tree = sh(["rev-parse", "HEAD^{tree}"], cwd);
    expect(r.record.tree).toBe(tree);
    expect(readRecord(tree, cwd)).toMatchObject({ tree, command: "verify:full" });
  });

  it("keys by TREE, so an amended commit with identical content is already verified", () => {
    // A rebase or a reworded message produces a new commit id for the same content, and it is the
    // content that was verified. Keying by commit would demand a pointless re-run.
    const cwd = repo();
    recordVerification({ cwd });
    const before = sh(["rev-parse", "HEAD"], cwd);
    execFileSync("git", ["commit", "-q", "--amend", "-m", "same content, new message"], { cwd, env: ENV });
    expect(sh(["rev-parse", "HEAD"], cwd)).not.toBe(before);
    expect(readRecord(treeOf("HEAD", cwd), cwd)).toBeTruthy();
  });

  it("REFUSES to record a dirty working tree — no commit can honestly claim that run", () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "a.txt"), "edited but not committed\n");
    expect(verifiableTree(cwd)).toBeNull();
    const r = recordVerification({ cwd });
    expect(r.recorded).toBe(false);
    expect(r.reason).toMatch(/dirty/);
    // and crucially: HEAD must NOT come out looking verified
    expect(readRecord(sh(["rev-parse", "HEAD^{tree}"], cwd), cwd)).toBeUndefined();
  });

  it("a changed tree has no record — the proof does not carry over to different content", () => {
    const cwd = repo();
    recordVerification({ cwd });
    fs.writeFileSync(path.join(cwd, "a.txt"), "two\n");
    execFileSync("git", ["commit", "-qam", "change"], { cwd, env: ENV });
    expect(readRecord(treeOf("HEAD", cwd), cwd)).toBeUndefined();
  });

  it("is shared across linked worktrees — verify in one, land from the other", () => {
    // This is why the record lives under the common git dir. The landing flow verifies INSIDE a
    // change worktree and moves the trunk from the primary checkout; a record only the worktree could
    // read would be gone exactly when the trunk needs it.
    const cwd = repo();
    const wt = path.join(cwd, "..", `wt-${path.basename(cwd)}`);
    dirs.push(wt);
    execFileSync("git", ["worktree", "add", "-q", "-b", "topic", wt], { cwd, env: ENV });
    expect(recordDir(wt)).toBe(recordDir(cwd));
    const r = recordVerification({ cwd: wt });
    expect(r.recorded).toBe(true);
    expect(readRecord(r.record.tree, cwd)).toBeTruthy(); // readable from the primary checkout
  });

  it("treats a malformed record as absent — a proof that cannot be read is not a proof", () => {
    const cwd = repo();
    const r = recordVerification({ cwd });
    fs.writeFileSync(path.join(recordDir(cwd), `${r.record.tree}.json`), "{ not json");
    expect(readRecord(r.record.tree, cwd)).toBeUndefined();
  });

  it("treats a record whose tree does not match its filename as absent", () => {
    const cwd = repo();
    const r = recordVerification({ cwd });
    const file = path.join(recordDir(cwd), `${r.record.tree}.json`);
    fs.writeFileSync(file, JSON.stringify({ schema: 1, tree: "0".repeat(40), at: "now" }));
    expect(readRecord(r.record.tree, cwd)).toBeUndefined();
  });
});
