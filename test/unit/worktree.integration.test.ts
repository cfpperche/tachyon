import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager, WorktreeUnavailableError, resolveWorktreeCwd } from "../../src/worktree/WorktreeManager.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

/** Real-git integration: create/reuse/attach/fail/dirty/ahead/remove on a tmp repo. */
describe("WorktreeManager — git side (real git, tmp repo)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-repo-"));
    dirs.push(d);
    git(["init", "-b", "main"], d);
    git(["config", "user.email", "t@t.dev"], d);
    git(["config", "user.name", "T"], d);
    fs.writeFileSync(path.join(d, "README.md"), "hi\n");
    git(["add", "-A"], d);
    git(["commit", "-m", "init"], d);
    return d;
  }

  function mgr(workspaceRoot = repo, settings: TachyonConfig["settings"] = { worktree: { base } }) {
    return new WorktreeManager({ workspaceRoot, wsHash: "h", getSettings: () => settings });
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "wt-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("isUsableRepo: ok for a normal repo; not-repo / unborn flagged", async () => {
    expect((await mgr().isUsableRepo()).ok).toBe(true);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "wt-plain-"));
    dirs.push(plain);
    expect(await mgr(plain).isUsableRepo()).toMatchObject({ ok: false, reason: "not-repo" });
    const unborn = fs.mkdtempSync(path.join(os.tmpdir(), "wt-unborn-"));
    dirs.push(unborn);
    git(["init", "-b", "main"], unborn);
    expect(await mgr(unborn).isUsableRepo()).toMatchObject({ ok: false, reason: "unborn" });
  });

  it("ensure CREATES a worktree on a new Tachyon-owned branch", async () => {
    const { record: rec } = await mgr().ensure({ agent: "rev", branch: "tachyon/rev" });
    expect(rec.path).toBe(path.join(base, "h", "rev"));
    expect(rec.branch).toBe("tachyon/rev");
    expect(rec.tachyonCreatedBranch).toBe(true);
    expect(fs.existsSync(rec.path)).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], rec.path).trim()).toBe("tachyon/rev");
    // edits in the worktree don't touch the main tree
    fs.writeFileSync(path.join(rec.path, "only-here.txt"), "x");
    expect(fs.existsSync(path.join(repo, "only-here.txt"))).toBe(false);
  });

  it("ensure REUSES a valid existing worktree (same repo + branch)", async () => {
    const m = mgr();
    const { record: first } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    const { record: again } = await m.ensure({ agent: "rev", branch: "tachyon/rev", prior: first });
    expect(again).toEqual(first); // no throw, reused
  });

  it("ensure REJECTS reuse when the worktree drifted to another branch", async () => {
    const m = mgr();
    const { record: rec } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    git(["checkout", "-b", "sneaky"], rec.path); // user switched the branch inside
    await expect(m.ensure({ agent: "rev", branch: "tachyon/rev" })).rejects.toThrow(/reuse/i);
  });

  it("ensure ATTACHES an existing (human) branch, NOT marked Tachyon-created", async () => {
    git(["branch", "feature/x"], repo); // pre-existing human branch, not checked out
    const { record: rec } = await mgr().ensure({ agent: "feat", branch: "feature/x" });
    expect(rec.tachyonCreatedBranch).toBe(false);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], rec.path).trim()).toBe("feature/x");
  });

  it("ensure FAILS when the branch is already checked out elsewhere", async () => {
    const m = mgr();
    await m.ensure({ agent: "rev", branch: "shared" }); // creates + checks out 'shared'
    await expect(m.ensure({ agent: "rev2", branch: "shared" })).rejects.toThrow(WorktreeUnavailableError);
  });

  it("status reports untracked + ahead", async () => {
    const m = mgr();
    const { record: rec } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    fs.writeFileSync(path.join(rec.path, "scratch.txt"), "wip");
    let st = await m.status(rec.path, rec.baseRef);
    expect(st.untracked).toBe(1);
    expect(st.aheadOfBase).toBe(0);
    git(["add", "-A"], rec.path);
    git(["commit", "-m", "work"], rec.path);
    st = await m.status(rec.path, rec.baseRef);
    expect(st.aheadOfBase).toBe(1);
    expect(st.untracked).toBe(0);
    expect(st.branch).toBe("tachyon/rev");
  });

  it("E2E: resolveWorktreeCwd creates the worktree, runs setup with TACHYON env, status sees edits, remove cleans up", async () => {
    const m = mgr();
    const notices: string[] = [];
    const r = await resolveWorktreeCwd(
      { name: "rev", worktree: true, branch: "tachyon/rev", worktreeSetup: ["echo hi > setup-marker.txt", 'echo "$TACHYON_WORKTREE_ROOT" > env-marker.txt'], isRestart: false },
      {
        manager: m,
        settings: { worktree: { base } },
        parentCwd: () => undefined,
        runSetup: async (rec, setup) => {
          const env = { ...process.env, TACHYON_WORKSPACE_ROOT: repo, TACHYON_WORKTREE_ROOT: rec.path };
          for (const c of setup) execFileSync("bash", ["-lc", c], { cwd: rec.path, env });
        },
        notify: (n) => notices.push(n),
      },
    );
    expect(r?.cwd).toBe(path.join(base, "h", "rev"));
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], r!.cwd).trim()).toBe("tachyon/rev"); // on its branch
    expect(fs.readFileSync(path.join(r!.cwd, "setup-marker.txt"), "utf8").trim()).toBe("hi"); // setup ran
    expect(fs.readFileSync(path.join(r!.cwd, "env-marker.txt"), "utf8").trim()).toBe(r!.cwd); // TACHYON_WORKTREE_ROOT injected
    const st = await m.status(r!.cwd, r!.worktree!.baseRef);
    expect(st.untracked).toBeGreaterThan(0); // setup files are untracked → cleanup would warn
    const rm = await m.remove(r!.worktree!, true);
    expect(rm).toMatchObject({ removed: true, branchDeleted: true });
    expect(fs.existsSync(r!.cwd)).toBe(false);
  });

  it("C2: changedFiles reports M/D/untracked vs baseRef; showFile returns base content (spec 213)", async () => {
    // base has README.md (from mkRepo) + lib.txt
    fs.writeFileSync(path.join(repo, "lib.txt"), "lib\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "add lib"], repo);
    const m = mgr();
    const { record: rec } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    fs.writeFileSync(path.join(rec.path, "README.md"), "changed\n"); // M (uncommitted)
    fs.rmSync(path.join(rec.path, "lib.txt")); // D
    fs.writeFileSync(path.join(rec.path, "new.txt"), "new\n"); // A (untracked)

    const changes = await m.changedFiles(rec.path, rec.baseRef);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
    expect(byPath).toEqual({ "README.md": "M", "lib.txt": "D", "new.txt": "A" });

    expect(await m.showFile(rec.path, rec.baseRef, "README.md")).toBe("hi\n"); // base content
    expect(await m.showFile(rec.path, rec.baseRef, "new.txt")).toBe(""); // absent at base → empty
  });

  it("C2: changedFiles is empty when nothing changed, and tolerates a missing worktree", async () => {
    const m = mgr();
    const { record: rec } = await m.ensure({ agent: "clean", branch: "tachyon/clean" });
    expect(await m.changedFiles(rec.path, rec.baseRef)).toEqual([]); // fresh worktree, no edits
    fs.rmSync(rec.path, { recursive: true, force: true });
    expect(await m.changedFiles(rec.path, rec.baseRef)).toEqual([]); // gone → no crash
  });

  it("remove deletes the worktree and ONLY a Tachyon-created branch", async () => {
    const m = mgr();
    const { record: owned } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    const r1 = await m.remove(owned, true);
    expect(r1).toMatchObject({ removed: true, branchDeleted: true });
    expect(fs.existsSync(owned.path)).toBe(false);
    expect(() => git(["rev-parse", "--verify", "tachyon/rev"], repo)).toThrow(); // branch gone

    git(["branch", "feature/keep"], repo);
    const { record: human } = await m.ensure({ agent: "feat", branch: "feature/keep" });
    const r2 = await m.remove(human, true); // even with deleteBranch=true...
    expect(r2.removed).toBe(true);
    expect(r2.branchDeleted).toBe(false); // ...a human branch is NEVER force-deleted
    expect(git(["rev-parse", "--verify", "feature/keep"], repo).trim()).toBeTruthy(); // still there
  });

  it("hardening: a Tachyon branch with UNMERGED commits survives remove() (safe -d), force-deletes only via deleteBranch", async () => {
    const m = mgr();
    const { record: rec } = await m.ensure({ agent: "rev", branch: "tachyon/rev" });
    fs.writeFileSync(path.join(rec.path, "work.txt"), "important");
    git(["add", "-A"], rec.path);
    git(["commit", "-m", "agent work"], rec.path); // committed but NOT merged into main
    const r = await m.remove(rec, true);
    expect(r.removed).toBe(true);
    expect(r.branchDeleted).toBe(false); // safe-delete refused → work preserved
    expect(git(["rev-parse", "--verify", "tachyon/rev"], repo).trim()).toBeTruthy(); // branch still there
    // the commit is recoverable from the kept branch
    expect(git(["log", "--oneline", "tachyon/rev"], repo)).toContain("agent work");
    // explicit force-delete (the spelled-out 2nd confirm) does remove it
    expect(await m.deleteBranch("tachyon/rev")).toBe(true);
    expect(() => git(["rev-parse", "--verify", "tachyon/rev"], repo)).toThrow();
  });
});
