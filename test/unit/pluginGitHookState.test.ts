import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gatherGitHookState, capturePriorHook } from "../../src/plugins/gitHookState.js";

function gitOk(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ghstate-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: ENV });
  return dir;
}

describe.skipIf(!gitOk())("gatherGitHookState (spec 264)", () => {
  it("reports not-a-repo outside git", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-norepo-"));
    dirs.push(dir);
    expect(await gatherGitHookState(dir, ["pre-commit"])).toMatchObject({ isRepo: false, worktreeConfig: false });
  });

  it("captures an executable default pre-commit as the prior hook (ignores .sample / non-exec)", async () => {
    const dir = makeRepo();
    const hooks = path.join(dir, ".git", "hooks");
    fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const st = await gatherGitHookState(dir, ["pre-commit"]);
    expect(st.isRepo).toBe(true);
    expect(st.priorHooks["pre-commit"]).toMatchObject({ type: "file" });
    expect(st.priorHooks["pre-commit"]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // a non-executable hook is NOT captured (git wouldn't run it)
    fs.chmodSync(path.join(hooks, "pre-commit"), 0o644);
    expect((await gatherGitHookState(dir, ["pre-commit"])).priorHooks["pre-commit"]).toBeNull();
  });

  it("reads core.hooksPath and worktreeConfig", async () => {
    const dir = makeRepo();
    execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: dir, env: ENV });
    const st = await gatherGitHookState(dir, ["pre-commit"]);
    expect(st.hooksPath?.raw).toBe(".husky");
    expect(st.worktreeConfig).toBe(false);
  });

  it("capturePriorHook ignores a .sample and a missing file", () => {
    expect(capturePriorHook("/nonexistent/pre-commit")).toBeNull();
    const dir = makeRepo();
    expect(capturePriorHook(path.join(dir, ".git/hooks/pre-commit.sample"))).toBeNull();
  });
});
