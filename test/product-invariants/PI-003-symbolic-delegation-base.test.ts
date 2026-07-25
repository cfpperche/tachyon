import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "../../src/worktree/WorktreeManager.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

/**
 * PI-003 — a delegation's containment is evaluated against a SYMBOLIC base, never a pinned commit.
 *
 * Promise (already ratified, made executable here): spec 365 states the recorded base is
 * "baseRef (name, not frozen SHA)". Containment asks whether a delegation's tip is contained in its
 * base. Against a branch name that question tracks the trunk; against a pinned SHA it becomes a
 * ceiling, and every new commit moves the tip further from the pin — so containment refuses forever
 * and the delivery can never be integrated or pruned. The defect was real (t-2dd637): a respawn onto
 * a preserved worktree whose first launch never persisted a ledger row dropped the base branch and
 * fell through to a spawn SHA.
 *
 * Fixed oracle — GIT's, not ours. A value qualifies only if it both satisfies git's branch-ref
 * grammar AND resolves under `refs/heads/`. The grammar half alone does not discriminate:
 * `git check-ref-format --branch <40-hex>` exits 0, because a SHA is a grammatically legal branch
 * name. Resolution is the half that separates a symbolic base from a pin, so both are required, and
 * neither is derived from the value the code under test produced.
 *
 * Registered variance: on a detached HEAD there is no branch to name, so no base is recorded at all.
 * That is fail-closed and part of the promise — the canonical gated open then refuses with
 * DELIVERY_BASE_REF_UNRESOLVED rather than inventing a pin.
 */
describe("PI-003 — gated delegation containment is evaluated against a symbolic base", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  /** The fixed oracle: git's own grammar check AND git's own ref resolution. */
  function isSymbolicBranchRef(value: string, cwd: string): boolean {
    const run = (args: string[]) => {
      try {
        execFileSync("git", args, { cwd, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    return run(["check-ref-format", "--branch", value]) && run(["show-ref", "--verify", `refs/heads/${value}`]);
  }

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi003-repo-"));
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
    base = fs.mkdtempSync(path.join(os.tmpdir(), "pi003-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("records a symbolic branch as the projection base on every path that records one", async () => {
    const m = mgr();

    // Two paths reach the recorded base: a clean create, and the prior-less reuse that produced the
    // original defect (a preserved checkout whose ledger row was never written).
    const created = (await m.ensure({ agent: "prop", branch: "tachyon/prop" })).record;
    const reused = (await m.ensure({ agent: "prop", branch: "tachyon/prop" })).record;

    for (const [label, record] of [["create", created], ["prior-less reuse", reused]] as const) {
      expect(record.baseBranch, `${label} path must carry a base branch`).toBeDefined();
      expect(isSymbolicBranchRef(record.baseBranch!, repo), `${label} base must be a symbolic branch ref`).toBe(true);
    }

    // The oracle has teeth: the fork-point SHA these paths fall back to when the fix regresses is NOT
    // a symbolic branch ref, so the assertions above cannot pass vacuously.
    expect(isSymbolicBranchRef(reused.baseRef, repo)).toBe(false);
  });

  it("records NO base rather than inventing one when the workspace root is on a detached HEAD", async () => {
    // Registered variance, and the fail-closed half of the promise: with no symbolic branch to
    // re-derive, a pin must not be substituted. The gated open refuses downstream instead.
    const m = mgr();
    await m.ensure({ agent: "detached", branch: "tachyon/detached" });
    git(["checkout", "--detach"], repo);

    const reused = await m.ensure({ agent: "detached", branch: "tachyon/detached" });
    expect(reused.created).toBe(false);
    expect(reused.record.baseBranch).toBeUndefined();
  });
});
