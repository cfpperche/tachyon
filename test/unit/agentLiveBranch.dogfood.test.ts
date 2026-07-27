/**
 * Dogfood (real git): live HEAD branch for sidebar badge (spec 384).
 * Exercises WorktreeManager.currentBranch + drift projection the gather path uses.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "../../src/worktree/WorktreeManager.js";
import { toAgentVM } from "../../src/sidebar/agentModel.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

describe("spec 384 dogfood — live branch (real git)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "live-branch-repo-"));
    dirs.push(d);
    git(["init", "-b", "main"], d);
    git(["config", "user.email", "t@t.dev"], d);
    git(["config", "user.name", "T"], d);
    fs.writeFileSync(path.join(d, "README.md"), "hi\n");
    git(["add", "-A"], d);
    git(["commit", "-m", "init"], d);
    return d;
  }

  function mgr() {
    return new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => ({ worktree: { base } }) as TachyonConfig["settings"],
      occupancy: async () => undefined,
    });
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "live-branch-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("shared workspace cwd reports live main", async () => {
    const branch = await mgr().currentBranch(repo);
    expect(branch).toBe("main");
    const vm = toAgentVM(
      { name: "shared", running: true, dead: false, crashed: false },
      { liveBranch: branch!, worktreePath: repo, kind: "agent" },
    );
    expect(vm.liveBranch).toBe("main");
    expect(vm.worktree).toBeUndefined();
    expect(vm.branchDrift).toBeUndefined();
  });

  it("worktree agent: live matches config, then drift after checkout", async () => {
    const m = mgr();
    const { record } = await m.ensure({ agent: "soul", branch: "tachyon/soul" });
    expect(await m.currentBranch(record.path)).toBe("tachyon/soul");

    const aligned = toAgentVM(
      { name: "soul", running: true, dead: false, crashed: false },
      {
        worktree: record.branch,
        liveBranch: (await m.currentBranch(record.path))!,
        worktreePath: record.path,
        kind: "agent",
      },
    );
    expect(aligned).toMatchObject({ liveBranch: "tachyon/soul", worktree: "tachyon/soul" });
    expect(aligned.branchDrift).toBeUndefined();

    git(["checkout", "-b", "feat/live-demo"], record.path);
    const live = await m.currentBranch(record.path);
    expect(live).toBe("feat/live-demo");
    const drift = !!record.branch && record.branch !== live;
    expect(drift).toBe(true);

    const drifted = toAgentVM(
      { name: "soul", running: true, dead: false, crashed: false },
      {
        worktree: record.branch,
        liveBranch: live!,
        branchDrift: drift,
        worktreePath: record.path,
        kind: "agent",
      },
    );
    expect(drifted).toMatchObject({
      liveBranch: "feat/live-demo",
      worktree: "tachyon/soul",
      branchDrift: true,
    });
  });

  it("detached HEAD omits live branch (best-effort)", async () => {
    const sha = git(["rev-parse", "HEAD"], repo).trim();
    git(["checkout", "--detach", sha], repo);
    expect(await mgr().currentBranch(repo)).toBeUndefined();
  });
});
