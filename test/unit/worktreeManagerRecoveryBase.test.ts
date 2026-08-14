import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "@tachyon/engine/worktree/WorktreeManager.js";
import type { TachyonConfig } from "@tachyon/engine/config/loadConfig.js";

/**
 * t-2dd637 — recovery/reuse must carry a SYMBOLIC base branch.
 *
 * A respawn onto a preserved worktree whose first launch never persisted a ledger row reaches the
 * reuse path with `prior === undefined`. Before the fix every base-identity field was sourced from
 * `o.prior?.…`, so `baseBranch` was dropped and the canonical projection fell through to a pinned
 * spawn SHA. `containedInBase` then reads that pin as a containment ceiling rather than a fork
 * point and refuses forever, because each new commit moves the branch tip further from the pin.
 */
describe("WorktreeManager — prior-less recovery reuse base identity (t-2dd637)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-recovery-base-repo-"));
    dirs.push(d);
    git(["init", "-b", "main"], d);
    git(["config", "user.email", "t@t.dev"], d);
    git(["config", "user.name", "T"], d);
    fs.writeFileSync(path.join(d, "README.md"), "hi\n");
    git(["add", "-A"], d);
    git(["commit", "-m", "init"], d);
    return d;
  }

  function mgr(workspaceRoot = repo): WorktreeManager {
    return new WorktreeManager({
      workspaceRoot,
      wsHash: "h",
      getSettings: () => ({ worktree: { base } }) as TachyonConfig["settings"],
      occupancy: async () => undefined,
    });
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "wt-recovery-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("carries a symbolic base branch onto a prior-less recovery reuse", async () => {
    expect.hasAssertions();
    const m = mgr();

    // Clean spawn — the reference shape the recovery path must reproduce.
    const first = await m.ensure({ agent: "impl", branch: "tachyon/impl" });
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({ baseBranch: "main", tachyonCreatedBranch: true });

    // Respawn after a launch failure preserved the checkout: the ledger row was never written, so
    // the reuse path sees no prior at all. This is the exact defect shape.
    const reused = await m.ensure({ agent: "impl", branch: "tachyon/impl" });
    expect(reused.created).toBe(false);

    // Fix (A): base identity is re-derived from the workspace root instead of being dropped.
    expect(reused.record.baseBranch).toBe("main");

    // Pin the SAFE default. `false` means "ownership unknown without a prior → assume human-owned",
    // which keeps the branch from ever being force-deleted. A future change must not flip this to
    // `true` merely to unblock prune — that trades a stuck record for a destructive one. Holds at
    // BASE and at HEAD by design.
    expect(reused.record.tachyonCreatedBranch).toBe(false);
  });

  // The "projection base is always a symbolic branch ref" property lives in
  // test/unit/symbolicDelegationBase.test.ts. Two oracles for one promise drift; that file owns the
  // promise, this one keeps the mechanism coverage.

  it("leaves the base branch absent when the workspace root is on a detached HEAD", async () => {
    expect.hasAssertions();
    const m = mgr();
    await m.ensure({ agent: "detached", branch: "tachyon/detached" });

    // Fail-closed: with no symbolic branch to re-derive, the record must NOT invent one — the
    // canonical gated open then refuses (DELIVERY_BASE_REF_UNRESOLVED) rather than pinning a SHA.
    git(["checkout", "--detach"], repo);
    const reused = await m.ensure({ agent: "detached", branch: "tachyon/detached" });

    expect(reused.created).toBe(false);
    expect(reused.record.baseBranch).toBeUndefined();
  });
});
