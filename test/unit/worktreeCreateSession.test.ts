/**
 * t-0ab150 — a create that is still running (or that just failed) must be a row in the same
 * classified list as live worktrees, with a named phase, and must not be treated as a live
 * checkout by anything that acts on that list.
 *
 * Session-only: nothing here is allowed to appear in the on-disk registry. Create stays awaited.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagedWorktreeService } from "@tachyon/engine/worktree/ManagedWorktreeService.js";
import { WorktreeManager, defaultGitExec, type GitExec } from "@tachyon/engine/worktree/WorktreeManager.js";
import { loadManagedWorktreeStore, managedWorktreeStorePath } from "@tachyon/engine/worktree/managedWorktree.js";
import type { TachyonConfig } from "@tachyon/engine/config/loadConfig.js";

describe("t-0ab150 create-session row (real git)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mw-create-repo-"));
    dirs.push(d);
    git(["init", "-b", "main"], d);
    git(["config", "user.email", "t@t.dev"], d);
    git(["config", "user.name", "T"], d);
    fs.writeFileSync(path.join(d, "README.md"), "hi\n");
    git(["add", "-A"], d);
    git(["commit", "-m", "init"], d);
    return d;
  }

  function service(wrap?: (inner: GitExec) => GitExec) {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const exec = wrap ? wrap(defaultGitExec) : defaultGitExec;
    const manager = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      occupancy: async () => undefined,
      git: exec,
    });
    return new ManagedWorktreeService({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      manager,
      occupancy: async () => undefined,
      git: exec,
      now: () => "2026-08-19T12:00:00.000Z",
    });
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "mw-create-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("positive: during createChange the classified list has a session row with a named phase", async () => {
    let during: Awaited<ReturnType<ManagedWorktreeService["listClassified"]>> | undefined;
    const svc = service((inner) => async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "add" && !during) {
        during = await svc.listClassified();
      }
      return inner(args, cwd);
    });

    await svc.createChange({ slug: "in-flight", createdBy: "alice" });

    const row = during?.find((r) => r.slug === "in-flight");
    expect(row, "classified list must contain the creating worktree while git worktree add runs").toBeDefined();
    expect(row?.create?.phase).toBeTruthy();
    expect(typeof row?.create?.phase).toBe("string");
  });

  it("negative: after createChange the session row is gone and the registered worktree is not duplicated", async () => {
    let during: Awaited<ReturnType<ManagedWorktreeService["listClassified"]>> | undefined;
    const svc = service((inner) => async (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "add" && !during) {
        during = await svc.listClassified();
      }
      return inner(args, cwd);
    });

    const entry = await svc.createChange({ slug: "done-row", createdBy: "alice" });
    const after = await svc.listClassified();
    const matches = after.filter((r) => r.slug === "done-row" || r.path === entry.path);

    expect(during?.some((r) => r.slug === "done-row" && r.create), "a session row must have existed during create").toBe(true);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.create).toBeUndefined();
    expect(matches[0]?.id).toBe(entry.id);
    expect(svc.list({ kind: "change" })).toHaveLength(1);

    const store = loadManagedWorktreeStore(managedWorktreeStorePath(repo));
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).not.toHaveProperty("create");
    expect(store.entries[0]?.status).toBe("active");
  });

  it("silent undo: a session row is not ready-to-remove, not scanned by reconcile, and removeClassified does not delete it", async () => {
    const svc = service();
    await expect(svc.createChange({ slug: "broke", branch: "invalid branch", createdBy: "alice" })).rejects.toThrow(/invalid branch name/);

    const rows = await svc.listClassified();
    const row = rows.find((r) => r.slug === "broke");
    expect(row, "failed create must leave a session row with the error").toBeDefined();
    expect(row?.create?.error).toMatch(/invalid branch name/);
    expect(row?.classification?.state).not.toBe("ready-to-remove");
    expect(row?.classification?.state).not.toBe("record-only");

    const refused = await svc.removeClassified(row!.id, { actor: { kind: "human" } });
    expect(refused.removed).toBe(false);
    expect(svc.list()).toHaveLength(0);

    const report = await svc.reconcileHygiene({ actor: { kind: "human" }, deleteBranch: true });
    expect(report.scanned).toBe(0);
    expect(report.removed).toEqual([]);
    expect(rows.filter((r) => r.slug === "broke")).toHaveLength(1);

    const store = loadManagedWorktreeStore(managedWorktreeStorePath(repo));
    expect(store.entries).toHaveLength(0);
  });
});
