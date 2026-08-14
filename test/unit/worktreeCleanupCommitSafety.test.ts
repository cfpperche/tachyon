/**
 * spec 444 — a destructive worktree/branch cleanup action must never discard unique, unmerged
 * commits without an explicit, informed override. Fixed oracle: git ancestry.
 *
 * Two independent angles on the same promise, both against a REAL git repo (no fakes):
 *  1. Tachyon's own classifier (the thing that decides whether "Remove checkout" is even OFFERED)
 *     never returns `ready-to-remove` for a worktree carrying a commit not contained in its base.
 *  2. Git's own native safety net (`git branch -d`, the safe delete `ManagedWorktreeService.remove`
 *     uses for Tachyon-owned branches) independently refuses to delete that same branch — so the
 *     promise doesn't rest on Tachyon's classifier alone; the underlying git mechanism agrees.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ManagedWorktreeService } from "@tachyon/engine/worktree/ManagedWorktreeService.js";
import { WorktreeManager } from "@tachyon/engine/worktree/WorktreeManager.js";
import type { TachyonConfig } from "@tachyon/engine/config/loadConfig.js";

const PI_002 = Object.freeze({
  id: "worktree-cleanup-commit-safety",
  promise: "a destructive worktree/branch cleanup action never discards unique, unmerged commits without an explicit, informed override",
} as const);

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe(`${PI_002.id}: worktree cleanup commit safety`, () => {
  beforeEach(() => {
    // The Product Invariant runner (and the plain unit-test config, which lacks its setupFiles)
    // both require this guard so a conditional early return can never read as a silent pass.
    expect.hasAssertions();
  });

  it(PI_002.promise, async () => {
    const dirs: string[] = [];
    try {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-002-repo-"));
      dirs.push(repo);
      git(["init", "-b", "main"], repo);
      git(["config", "user.email", "t@t.dev"], repo);
      git(["config", "user.name", "T"], repo);
      fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
      git(["add", "-A"], repo);
      git(["commit", "-m", "init"], repo);

      const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-002-base-"));
      dirs.push(base);
      const settings: TachyonConfig["settings"] = { worktree: { base } };
      const manager = new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings });
      const svc = new ManagedWorktreeService({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, manager });

      const entry = await svc.createChange({ slug: "pi002-unique-work", createdBy: "tester" });
      // A real, committed, UNIQUE change — not merged anywhere else. This is exactly the case
      // this test exists to protect: losing this commit would be a real, silent loss of work.
      fs.writeFileSync(path.join(entry.path, "unique.txt"), "irreplaceable work\n");
      git(["add", "-A"], entry.path);
      git(["commit", "-m", "unique unmerged work"], entry.path);

      // Angle 1: Tachyon's own classifier must never call this safe to remove.
      const [row] = await svc.listClassified({ kind: "change" });
      expect(row?.id).toBe(entry.id);
      expect(row?.classification.aheadOfBase).toBeGreaterThan(0);
      expect(row?.classification.containedInBase).toBe(false);
      expect(row?.classification.state).not.toBe("ready-to-remove");
      expect(row?.classification.state).toBe("needs-review");
      expect(row?.classification.reasons.join(" ")).toMatch(/not contained in base/);

      // Angle 2: git's own safe-delete independently refuses this branch, backing the same promise.
      // Remove the checkout FIRST (what ManagedWorktreeService.remove's worktree-removal step would
      // do) so the only remaining reason `branch -d` could refuse is the unmerged-commit protection
      // itself — otherwise "still checked out in a worktree" would refuse for an unrelated reason
      // and this angle wouldn't actually be testing this promise.
      git(["worktree", "remove", "--force", entry.path], repo);
      let branchDeleteRefused = false;
      let branchDeleteError = "";
      try {
        git(["branch", "-d", entry.branch], repo);
      } catch (err) {
        branchDeleteRefused = true;
        branchDeleteError = err instanceof Error ? err.message : String(err);
      }
      expect(branchDeleteRefused).toBe(true);
      expect(branchDeleteError).toMatch(/not fully merged/i);
      // The branch (and its unique commit) genuinely still exists — nothing was silently discarded.
      const branches = git(["branch", "--list", entry.branch], repo);
      expect(branches).toContain(entry.branch);
    } finally {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("unknown ancestry (unresolvable baseRef) is never claimed safe — the probe RESOLVES with a failure flag, it does not throw", async () => {
    // Adversarial-review blocker (2026-07-24): WorktreeManager.status() best-effort-coerces a
    // failed `rev-list baseRef..HEAD` to aheadOfBase 0 and RESOLVES — the throwing-mock shape the
    // original evidence pinned never occurs for this failure mode in production. This case pins the
    // REAL shape against real git: a registered baseRef that no longer resolves must classify
    // needs-review (never ready-to-remove), and the classification-gated removal must refuse.
    const dirs: string[] = [];
    try {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-002b-repo-"));
      dirs.push(repo);
      git(["init", "-b", "main"], repo);
      git(["config", "user.email", "t@t.dev"], repo);
      git(["config", "user.name", "T"], repo);
      fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
      git(["add", "-A"], repo);
      git(["commit", "-m", "init"], repo);

      const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-002b-base-"));
      dirs.push(base);
      const settings: TachyonConfig["settings"] = { worktree: { base } };
      const manager = new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings });
      const svc = new ManagedWorktreeService({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, manager });

      const entry = await svc.createChange({ slug: "pi002b-unknown-ancestry", createdBy: "tester" });
      fs.writeFileSync(path.join(entry.path, "work.txt"), "possibly unique work\n");
      git(["add", "-A"], entry.path);
      git(["commit", "-m", "work of unknown ancestry"], entry.path);
      // Corrupt the recorded baseRef the way production gets there (deleted/gc'd/typo'd ref).
      const storePath = path.join(repo, ".tachyon", "managed-worktrees.json");
      const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as { entries: Array<{ id: string; baseRef: string }> };
      for (const e of store.entries) if (e.id === entry.id) e.baseRef = "refs/heads/deleted-base";
      fs.writeFileSync(storePath, JSON.stringify({ schemaVersion: 1, entries: store.entries }, null, 2));

      const [row] = await svc.listClassified({ kind: "change" });
      expect(row?.classification.state).not.toBe("ready-to-remove");
      expect(row?.classification.state).toBe("needs-review");
      expect(row?.classification.containedInBase).toBe(false);

      const refused = await svc.removeClassified(entry.id, { actor: { kind: "human" } });
      expect(refused.removed).toBe(false);
      expect(fs.existsSync(entry.path)).toBe(true);
    } finally {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
