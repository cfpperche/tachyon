/**
 * t-361963 — worktree removal must probe /proc for cwd descendants BEFORE rm.
 *
 * Three required cases:
 *   positive: a live process with cwd under the checkout is named in the refusal
 *   negative: no such process → removal proceeds as today
 *   override: confirmLiveProcesses removes anyway and does not kill anyone
 *
 * Fail-before is the contract: these assertions are false on the tree that
 * deletes first and reports later.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultGitExec, WorktreeManager } from "@tachyon/engine/worktree/WorktreeManager.js";
import type { TachyonConfig } from "@tachyon/engine/config/loadConfig.js";
import {
  PROC_UNAVAILABLE_REASON,
  PROC_WALK_FAILED_REASON,
  worktreeKeptAfterRemoval,
} from "@tachyon/engine/worktree/orphanProcessHygiene.js";

describe("t-361963: probe live cwd processes before worktree remove", () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-liveproc-repo-"));
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
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    return new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      occupancy: async () => undefined,
    });
  }

  function holdCwd(dir: string): { pid: number; kill: () => void } {
    const child = spawn("sleep", ["120"], { cwd: dir, stdio: "ignore" });
    children.push(child);
    if (child.pid === undefined) throw new Error("sleep did not start");
    const cwd = fs.readlinkSync(`/proc/${child.pid}/cwd`);
    expect(path.resolve(cwd)).toBe(fs.realpathSync(dir));
    return {
      pid: child.pid,
      kill: () => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      },
    };
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "wt-liveproc-base-"));
    dirs.push(base);
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* leftover hold */ }
    }
  });

  it("positive: names the live process whose cwd is under the worktree and refuses", async () => {
    const m = mgr();
    const { record } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    const held = holdCwd(record.path);

    const result = await m.remove(record, true);

    expect(result.removed).toBe(false);
    expect(result.error).toMatch(new RegExp(`pid ${held.pid}`));
    expect(result.error).toMatch(/sleep/);
    expect(result.error).toMatch(/confirmLiveProcesses=true/);
    expect(result.error).toMatch(/will not kill/i);
    expect(fs.existsSync(record.path)).toBe(true);
    expect(alive(held.pid)).toBe(true);
  });

  it("negative: with no descendant process, removal proceeds as today", async () => {
    const m = mgr();
    const { record } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });

    const result = await m.remove(record, true);

    expect(result).toMatchObject({ removed: true, branchDeleted: true });
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(record.path)).toBe(false);
  });

  it("override: confirmLiveProcesses removes with a live process and does not kill it", async () => {
    const m = mgr();
    const { record } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    const held = holdCwd(record.path);

    const result = await m.remove(record, true, { confirmLiveProcesses: true });

    expect(result.removed).toBe(true);
    expect(fs.existsSync(record.path)).toBe(false);
    expect(alive(held.pid)).toBe(true);
  });

  it("t-9fd2e6: git exit 0 is not removal — live cwd still on disk means kept, not removed", async () => {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const m = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      occupancy: async () => undefined,
      git: async (args, cwd) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          return { stdout: "", stderr: "", code: 0 };
        }
        return defaultGitExec(args, cwd);
      },
    });
    const { record } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    const held = holdCwd(record.path);

    const result = await m.remove(record, true, { confirmLiveProcesses: true });

    expect(result.removed).toBe(false);
    expect(result.kept).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(result.error).toMatch(/KEPT/);
    expect(result.error).not.toMatch(/was removed/);
    expect(result.error).toContain(record.path);
    expect(result.error).toMatch(new RegExp(`pid ${held.pid}`));
    expect(fs.existsSync(record.path)).toBe(true);
    expect(alive(held.pid)).toBe(true);
  });

  it("worktreeKeptAfterRemoval names the path and the live pid, never 'was removed'", () => {
    const text = worktreeKeptAfterRemoval("/wt", {
      worktreePath: "/wt",
      scanned: 1,
      unreadable: 0,
      measured: true,
      processes: [{ pid: 9, cwd: "/wt", command: "sleep" }],
    }, { stillListed: true, stillOnDisk: true });
    expect(text).toBe("worktree KEPT at /wt — 1 live process still has cwd there (pid 9 sleep); git still lists it as a worktree");
    expect(text).not.toMatch(/was removed/);
  });

  it("a failed /proc walk (instrument exists) is a declared refusal, not an empty finding", async () => {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const m = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      occupancy: async () => undefined,
      processProbe: (worktreePath) => ({
        worktreePath,
        scanned: 0,
        unreadable: 1,
        measured: false,
        unavailableReason: PROC_WALK_FAILED_REASON,
        processes: [],
      }),
    });
    const { record } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    const refused = await m.remove(record, true);
    expect(refused.removed).toBe(false);
    expect(refused.error).toMatch(/cannot measure/);
    expect(refused.error).toMatch(/walk failed/);
    expect(refused.error).toMatch(/confirmLiveProcesses=true/);
    expect(fs.existsSync(record.path)).toBe(true);

    const forced = await m.remove(record, true, { confirmLiveProcesses: true });
    expect(forced.removed).toBe(true);
    expect(fs.existsSync(record.path)).toBe(false);
  });

  it("platform without /proc: removal proceeds and the result says it did not measure", async () => {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const m = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      occupancy: async () => undefined,
      processProbe: (worktreePath) => ({
        worktreePath,
        scanned: 0,
        unreadable: 1,
        measured: false,
        unavailableReason: PROC_UNAVAILABLE_REASON,
        processes: [],
      }),
    });
    const { record } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    const result = await m.remove(record, true);
    expect(result.removed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.processProbe).toEqual({
      measured: false,
      unavailableReason: PROC_UNAVAILABLE_REASON,
    });
    expect(fs.existsSync(record.path)).toBe(false);
  });
});
