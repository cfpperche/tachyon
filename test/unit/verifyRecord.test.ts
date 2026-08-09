import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readVerificationRecord } from "../../src/workspace/verifyRecordReader.js";
import type { GitExec } from "../../src/worktree/WorktreeManager.js";
// The verification runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- exercising the real recorder the verify path uses is the point.
import { recordVerification, readRecord, verifiableTree, treeOf } from "../../scripts/verify-record.mjs";

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
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir, env: ENV });
  return dir;
}
const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const gitExec: GitExec = async (args, cwd) => {
  try {
    return { code: 0, stdout: execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }), stderr: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
};

describe.skipIf(!gitOk())("verification record (t-47cc91)", () => {
  it("files a green under the tree it covered, and finds it again", () => {
    const cwd = repo();
    const r = recordVerification({ cwd, command: "verify:full", summary: "1 file" });
    expect(r.recorded).toBe(true);
    const tree = sh(["rev-parse", "HEAD^{tree}"], cwd);
    expect(r.record.tree).toBe(tree);
    expect(execFileSync("git", ["cat-file", "blob", r.ref], { cwd, env: ENV, encoding: "utf8" }))
      .toBe(`${JSON.stringify(r.record, null, 2)}\n`);
    expect(readRecord(tree, cwd)).toMatchObject({ tree, command: "verify:full" });
  });

  it("publishes a record that the host reader reads through the git ref, without a file fallback", async () => {
    const cwd = repo();
    const wt = path.join(cwd, "..", `reader-wt-${path.basename(cwd)}`);
    dirs.push(wt);
    execFileSync("git", ["worktree", "add", "-q", "-b", "reader-topic", wt], { cwd, env: ENV });
    const published = recordVerification({
      cwd: wt,
      command: "verify:full",
      fingerprint: "f".repeat(64),
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    expect(published.recorded).toBe(true);
    const legacyDir = sh(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    fs.rmSync(path.join(legacyDir, "tachyon-verify"), { recursive: true, force: true });
    await expect(readVerificationRecord(
      cwd,
      "HEAD",
      gitExec,
      undefined,
      () => Date.parse("2026-08-09T01:00:00.000Z"),
    )).resolves.toMatchObject({ tree: published.record.tree, command: "verify:full" });
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
    const r = recordVerification({ cwd: wt });
    expect(r.recorded).toBe(true);
    expect(readRecord(r.record.tree, cwd)).toBeTruthy(); // readable from the primary checkout
  });

  it("REFUSES to record when shared node_modules ran against lockfiles from another tree", () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "package-lock.json"), "primary lock\n");
    execFileSync("git", ["add", "package-lock.json"], { cwd, env: ENV });
    execFileSync("git", ["commit", "-qm", "add primary lockfile"], { cwd, env: ENV });
    fs.mkdirSync(path.join(cwd, "node_modules"));

    const wt = path.join(cwd, "..", `divergent-wt-${path.basename(cwd)}`);
    dirs.push(wt);
    execFileSync("git", ["worktree", "add", "-q", "-b", "divergent-topic", wt], { cwd, env: ENV });
    fs.writeFileSync(path.join(wt, "package-lock.json"), "worktree lock\n");
    execFileSync("git", ["commit", "-qam", "change worktree lockfile"], { cwd: wt, env: ENV });
    fs.symlinkSync(path.join(cwd, "node_modules"), path.join(wt, "node_modules"), "dir");

    const r = recordVerification({ cwd: wt });
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe("package-lock.json differs in content from the primary checkout — this worktree needs its own dependencies");
    expect(readRecord(sh(["rev-parse", "HEAD^{tree}"], wt), wt)).toBeUndefined();
  });

  it("still records divergent lockfiles when the worktree owns node_modules", () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "package-lock.json"), "primary lock\n");
    execFileSync("git", ["add", "package-lock.json"], { cwd, env: ENV });
    execFileSync("git", ["commit", "-qm", "add primary lockfile"], { cwd, env: ENV });

    const wt = path.join(cwd, "..", `owned-deps-wt-${path.basename(cwd)}`);
    dirs.push(wt);
    execFileSync("git", ["worktree", "add", "-q", "-b", "owned-deps-topic", wt], { cwd, env: ENV });
    fs.writeFileSync(path.join(wt, "package-lock.json"), "worktree lock\n");
    execFileSync("git", ["commit", "-qam", "change worktree lockfile"], { cwd: wt, env: ENV });
    fs.mkdirSync(path.join(wt, "node_modules"));

    expect(recordVerification({ cwd: wt }).recorded).toBe(true);
  });

  it("still records divergent lockfiles when node_modules links somewhere other than the primary checkout", () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "package-lock.json"), "primary lock\n");
    execFileSync("git", ["add", "package-lock.json"], { cwd, env: ENV });
    execFileSync("git", ["commit", "-qm", "add primary lockfile"], { cwd, env: ENV });

    const wt = path.join(cwd, "..", `foreign-deps-wt-${path.basename(cwd)}`);
    const foreign = path.join(cwd, "..", `foreign-deps-${path.basename(cwd)}`);
    dirs.push(wt, foreign);
    execFileSync("git", ["worktree", "add", "-q", "-b", "foreign-deps-topic", wt], { cwd, env: ENV });
    fs.writeFileSync(path.join(wt, "package-lock.json"), "worktree lock\n");
    execFileSync("git", ["commit", "-qam", "change worktree lockfile"], { cwd: wt, env: ENV });
    fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(wt, "node_modules"), "dir");

    expect(recordVerification({ cwd: wt }).recorded).toBe(true);
  });

  it("still records a shared node_modules link when neither checkout has a lockfile", () => {
    const cwd = repo();
    fs.mkdirSync(path.join(cwd, "node_modules"));
    const wt = path.join(cwd, "..", `no-lock-wt-${path.basename(cwd)}`);
    dirs.push(wt);
    execFileSync("git", ["worktree", "add", "-q", "-b", "no-lock-topic", wt], { cwd, env: ENV });
    fs.symlinkSync(path.join(cwd, "node_modules"), path.join(wt, "node_modules"), "dir");

    expect(recordVerification({ cwd: wt }).recorded).toBe(true);
  });

  it("keeps a blob-valued verification ref alive through gc and a git push", () => {
    const cwd = repo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "verify-record-remote-"));
    dirs.push(remote);
    execFileSync("git", ["init", "-q", "--bare"], { cwd: remote, env: ENV });
    const published = recordVerification({ cwd, fingerprint: "f".repeat(64) });
    const ref = `refs/tachyon/verify/${published.record.tree}`;
    const beforeGc = sh(["rev-parse", ref], cwd);

    execFileSync("git", ["gc", "--prune=now"], { cwd, env: ENV });
    expect(sh(["rev-parse", ref], cwd)).toBe(beforeGc);
    expect(sh(["cat-file", "-t", ref], cwd)).toBe("blob");

    execFileSync("git", ["push", remote, `${ref}:${ref}`], { cwd, env: ENV });
    expect(sh([`--git-dir=${remote}`, "rev-parse", ref], cwd)).toBe(beforeGc);
    expect(sh([`--git-dir=${remote}`, "cat-file", "-t", ref], cwd)).toBe("blob");
  });

  it("treats a malformed record as absent — a proof that cannot be read is not a proof", () => {
    const cwd = repo();
    const r = recordVerification({ cwd });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd, env: ENV, input: "{ not json", encoding: "utf8",
    }).trim();
    expect(blob).toMatch(/^[0-9a-f]{40}$/);
    sh(["update-ref", `refs/tachyon/verify/${r.record.tree}`, blob], cwd);
    expect(readRecord(r.record.tree, cwd)).toBeUndefined();
  });

  it("treats a record whose tree does not match its ref name as absent", () => {
    const cwd = repo();
    const r = recordVerification({ cwd });
    const mismatched = JSON.stringify({ schema: 1, tree: "0".repeat(40), at: "now" });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, env: ENV, input: mismatched, encoding: "utf8" }).trim();
    sh(["update-ref", `refs/tachyon/verify/${r.record.tree}`, blob], cwd);
    expect(readRecord(r.record.tree, cwd)).toBeUndefined();
  });
});
