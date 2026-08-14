import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitRepo, GitRepoError } from "../../apps/vscode-extension/src/plugins/gitRepo.js";

function gitOk(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

/** A fresh git repo with one commit; returns its top-level dir. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-gitrepo-"));
  dirs.push(dir);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV });
  run(["init", "-q"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "init"]);
  return dir;
}

describe.skipIf(!gitOk())("GitRepo (spec 264)", () => {
  it("reports a work tree, top level, common dir, and a worktree-correct hook path", async () => {
    const dir = makeRepo();
    const repo = new GitRepo(dir);
    expect(await repo.isWorkTree()).toBe(true);
    expect(fs.realpathSync(await repo.topLevel())).toBe(fs.realpathSync(dir));
    const hookPath = await repo.hookPath("pre-commit");
    expect(path.isAbsolute(hookPath)).toBe(true);
    expect(hookPath.endsWith(path.join("hooks", "pre-commit"))).toBe(true);
  });

  it("get/set/unset core.hooksPath round-trips (raw + resolved)", async () => {
    const dir = makeRepo();
    const repo = new GitRepo(dir);
    expect(await repo.getHooksPath()).toBeUndefined(); // unset by default
    await repo.setHooksPath(".tachyon/githooks");
    const v = await repo.getHooksPath();
    expect(v?.raw).toBe(".tachyon/githooks");
    expect(v?.resolved).toBe(path.join(fs.realpathSync(dir), ".tachyon/githooks")); // relative resolved against top level
    await repo.unsetHooksPath();
    expect(await repo.getHooksPath()).toBeUndefined();
    await repo.unsetHooksPath(); // unset-when-already-unset is a no-op (exit 5)
  });

  it("a linked worktree resolves hooks to the COMMON dir, not its own .git file", async () => {
    const dir = makeRepo();
    const wt = `${dir}-wt`;
    dirs.push(wt);
    execFileSync("git", ["worktree", "add", "-q", wt, "-b", "wtbranch"], { cwd: dir, encoding: "utf8", env: ENV });
    const main = new GitRepo(dir);
    const linked = new GitRepo(wt);
    // the linked worktree's hooks live under the SHARED common dir, not its own .git file.
    const mainCommon = fs.realpathSync(await main.commonDir());
    expect(fs.realpathSync(await linked.commonDir())).toBe(mainCommon);
    const linkedHook = await linked.hookPath("pre-commit"); // file may not exist; compare its (existing) parent dir
    expect(fs.realpathSync(path.dirname(linkedHook))).toBe(fs.realpathSync(path.join(mainCommon, "hooks")));
    expect(path.basename(linkedHook)).toBe("pre-commit");
  });

  // t-4781f3 — extensions.worktreeConfig alone (e.g. from an unrelated `git sparse-checkout disable`
  // some OTHER worktree ran, or VS Code's own git tooling auto-running it on a newly opened linked
  // worktree) must NOT block hook management: nothing about core.hooksPath itself became ambiguous.
  it("does not refuse core.hooksPath management when worktreeConfig is on but hooksPath itself is not worktree-scoped", async () => {
    const dir = makeRepo();
    execFileSync("git", ["config", "extensions.worktreeConfig", "true"], { cwd: dir, env: ENV });
    const repo = new GitRepo(dir);
    expect(await repo.worktreeConfigEnabled()).toBe(false);
    await repo.setHooksPath(".tachyon/githooks");
    expect((await repo.getHooksPath())?.raw).toBe(".tachyon/githooks");
    await repo.unsetHooksPath();
  });

  // The genuine ambiguity: THIS worktree's own config.worktree overrides core.hooksPath, so a
  // shared-scope write would silently disagree with what this worktree actually resolves.
  it("refuses to manage core.hooksPath when THIS worktree's own config.worktree overrides it", async () => {
    const dir = makeRepo();
    execFileSync("git", ["config", "extensions.worktreeConfig", "true"], { cwd: dir, env: ENV });
    execFileSync("git", ["config", "--worktree", "core.hooksPath", "/some/other/path"], { cwd: dir, env: ENV });
    const repo = new GitRepo(dir);
    expect(await repo.worktreeConfigEnabled()).toBe(true);
    await expect(repo.setHooksPath(".tachyon/githooks")).rejects.toBeInstanceOf(GitRepoError);
    await expect(repo.unsetHooksPath()).rejects.toBeInstanceOf(GitRepoError);
  });

  it("assertWorkTree throws outside a repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-norepo-"));
    dirs.push(dir);
    await expect(new GitRepo(dir).assertWorkTree()).rejects.toBeInstanceOf(GitRepoError);
  });
});
