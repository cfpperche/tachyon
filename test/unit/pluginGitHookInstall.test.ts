import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadPlugin, previewInstall, applyInstall, applyRemove, repairGitHooks } from "../../src/plugins/engine.js";
import { gatherGitHookState } from "../../src/plugins/gitHookState.js";
import { GitHookStore } from "../../src/plugins/gitHookRegistry.js";
import { GitRepo } from "../../src/plugins/gitRepo.js";

function gitOk(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ghinstall-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: ENV });
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir, env: ENV });
  return dir;
}

function makeGitHookPlugin(name: string, leafBody = "#!/bin/sh\nexit 0\n"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-plugin-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "gh", runtimes: ["claude"], gitHooks: { "pre-commit": { leaf: "githooks/scan.sh" } } }));
  fs.mkdirSync(path.join(dir, "githooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "githooks/scan.sh"), leafBody);
  return dir;
}

async function installGitHook(ws: string, pluginDir: string) {
  const { plugin } = loadPlugin(pluginDir);
  const target = new Set(plugin!.manifest.runtimes);
  const gitState = await gatherGitHookState(ws, plugin!.gitHooks.map((g) => g.event));
  const preview = previewInstall(plugin!, ws, target, gitState);
  return applyInstall(plugin!, preview, ws, target, { mcpConfirmed: true });
}

describe.skipIf(!gitOk())("git-hook install materialization (spec 264 task 7)", () => {
  it("claims core.hooksPath, writes the leaf+snapshot+dispatcher, ownership, and records the lockfile", async () => {
    const ws = makeRepo();
    const res = await installGitHook(ws, makeGitHookPlugin("sdd"));
    expect(res.installed).toBe(true);

    const store = new GitHookStore(ws);
    expect(await new GitRepo(ws).getHooksPath()).toMatchObject({ raw: ".tachyon/githooks" }); // claimed LAST
    expect(fs.existsSync(store.dispatcherFile("pre-commit"))).toBe(true);
    expect(fs.statSync(store.dispatcherFile("pre-commit")).mode & 0o111).toBeTruthy();
    const snap = store.readSnapshot();
    expect(snap?.events["pre-commit"].leaves).toHaveLength(1);
    expect(snap?.events["pre-commit"].leaves[0].pluginId).toBe("sdd");
    expect(store.hasLeaf(snap!.events["pre-commit"].leaves[0].contentHash)).toBe(true);
    expect(store.readOwnership()).toMatchObject({ claimedFrom: null, managedPath: ".tachyon/githooks", leafRefs: 1, generation: 1 });
    const lock = JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8")).plugins.sdd;
    expect(lock.gitHooks).toHaveLength(1);
    expect(lock.gitHooks[0]).toMatchObject({ event: "pre-commit", ownershipGeneration: 1 });
  });

  it("captures a pre-existing default pre-commit as the chained prior hook", async () => {
    const ws = makeRepo();
    fs.writeFileSync(path.join(ws, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect((await installGitHook(ws, makeGitHookPlugin("sdd"))).installed).toBe(true);
    const snap = new GitHookStore(ws).readSnapshot();
    expect(snap?.events["pre-commit"].priorHook).not.toBeNull();
    expect(snap?.events["pre-commit"].priorHook?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a second git-hook plugin coexists: refcount + generation bump, both leaves in the chain", async () => {
    const ws = makeRepo();
    expect((await installGitHook(ws, makeGitHookPlugin("aaa"))).installed).toBe(true);
    const r2 = await installGitHook(ws, makeGitHookPlugin("bbb", "#!/bin/sh\nexit 0\n# distinct\n"));
    expect(r2.errors).toEqual([]);
    expect(r2.installed).toBe(true);
    const store = new GitHookStore(ws);
    expect(store.readOwnership()).toMatchObject({ leafRefs: 2, generation: 2 });
    const leaves = store.readSnapshot()!.events["pre-commit"].leaves;
    expect(leaves.map((l) => l.pluginId)).toEqual(["aaa", "bbb"]); // canonical-id order
  });
});

describe.skipIf(!gitOk())("git-hook remove + restore (spec 264 task 8)", () => {
  it("removing the sole git-hook plugin restores core.hooksPath (unset) and tears down the managed dir", async () => {
    const ws = makeRepo();
    await installGitHook(ws, makeGitHookPlugin("sdd"));
    expect(await new GitRepo(ws).getHooksPath()).toMatchObject({ raw: ".tachyon/githooks" });
    expect((await applyRemove("sdd", ws)).removed).toBe(true);
    expect(await new GitRepo(ws).getHooksPath()).toBeUndefined(); // restored to unset (claimedFrom was null)
    expect(fs.existsSync(new GitHookStore(ws).dir())).toBe(false); // managed dir gone
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins.lock.json"))).toBe(false); // sole plugin gone → lockfile deleted
  });

  it("restores a pre-existing custom core.hooksPath (claimedFrom)", async () => {
    const ws = makeRepo();
    execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: ws, env: ENV });
    await installGitHook(ws, makeGitHookPlugin("sdd"));
    expect(await new GitRepo(ws).getHooksPath()).toMatchObject({ raw: ".tachyon/githooks" });
    await applyRemove("sdd", ws);
    expect(await new GitRepo(ws).getHooksPath()).toMatchObject({ raw: ".husky" }); // restored to the user's prior value
  });

  it("never deletes the user's own pre-commit hook on restore", async () => {
    const ws = makeRepo();
    fs.writeFileSync(path.join(ws, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await installGitHook(ws, makeGitHookPlugin("sdd"));
    await applyRemove("sdd", ws);
    expect(fs.existsSync(path.join(ws, ".git/hooks/pre-commit"))).toBe(true); // user's hook untouched
    expect(await new GitRepo(ws).getHooksPath()).toBeUndefined();
  });

  it("removing one of two plugins keeps the other (refcount, hooksPath stays managed)", async () => {
    const ws = makeRepo();
    await installGitHook(ws, makeGitHookPlugin("aaa"));
    await installGitHook(ws, makeGitHookPlugin("bbb", "#!/bin/sh\nexit 0\n# distinct\n"));
    expect((await applyRemove("aaa", ws)).removed).toBe(true);
    const store = new GitHookStore(ws);
    expect(await new GitRepo(ws).getHooksPath()).toMatchObject({ raw: ".tachyon/githooks" }); // still managed
    const snap = store.readSnapshot();
    expect(snap?.events["pre-commit"].leaves.map((l) => l.pluginId)).toEqual(["bbb"]);
    expect(store.readOwnership()).toMatchObject({ leafRefs: 1 });
    // removing the last restores
    expect((await applyRemove("bbb", ws)).removed).toBe(true);
    expect(await new GitRepo(ws).getHooksPath()).toBeUndefined();
  });
});

describe.skipIf(!gitOk())("git-hook repair / clone behavior (spec 264 task 9)", () => {
  it("clone-state (no managed dir, hooksPath unset) is inert; repair says install-by-source", async () => {
    const ws = makeRepo(); // a fresh repo with NO managed git-hook state, as a clone would have
    expect(await new GitRepo(ws).getHooksPath()).toBeUndefined(); // gate inert — hooksPath not claimed
    const r = await repairGitHooks(ws);
    expect(r.repaired).toBe(false);
    expect(r.reason).toMatch(/install the plugin by source/);
    expect(await new GitRepo(ws).getHooksPath()).toBeUndefined(); // repair never silently claimed
  });

  it("repair re-claims core.hooksPath when the managed state is intact but hooksPath drifted (a clone w/o .git/config)", async () => {
    const ws = makeRepo();
    await installGitHook(ws, makeGitHookPlugin("sdd"));
    // simulate a clone that carried the (committed) managed dir but not .git/config → hooksPath unset.
    execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: ws, env: ENV });
    expect(await new GitRepo(ws).getHooksPath()).toBeUndefined();
    const r = await repairGitHooks(ws);
    expect(r.repaired).toBe(true);
    expect(await new GitRepo(ws).getHooksPath()).toMatchObject({ raw: ".tachyon/githooks" });
    // a second repair is a no-op (already active)
    expect((await repairGitHooks(ws)).reason).toMatch(/already active/);
  });
});
