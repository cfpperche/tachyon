import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager, branchFor, resolveWorktreeCwd, type WorktreeRecord } from "@tachyon/engine/worktree/WorktreeManager.js";
import type { TachyonConfig } from "@tachyon/engine/config/loadConfig.js";

/**
 * spec 230 — Step 0 SPIKE: de-risk B2 (run-scoped worktree + per-node spawn-cwd override).
 *
 * Proves, against REAL git, that:
 *   1. A pipeline RUN can allocate ONE worktree under a synthetic NAME_RE-safe key `run-<id>`.
 *   2. Sequential nodes RE-RESOLVE to the SAME worktree (created once, then reused) — so the chain
 *      shares one checkout.
 *   3. The hand-off works: a file written by node A is visible to node B in the shared worktree
 *      (worktree-as-state).
 *   4. Distinct runs get distinct worktrees (isolation between runs).
 *   5. The Workspace-level override (Mechanism B) is expressible: a tiny resolver that returns the
 *      run worktree for ANY node name, sitting in front of the stock per-agent `resolveWorktreeCwd`.
 *
 * Conclusion (asserted by these tests): B2 needs NO AgentManager change — the run worktree is a normal
 * `ensure()` under a synthetic key, and the cwd override rides the existing `resolveSpawnCwd` seam.
 */
describe("spec 230 spike — run-scoped worktree + cwd override (real git)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pl-repo-"));
    dirs.push(d);
    git(["init", "-b", "main"], d);
    git(["config", "user.email", "t@t.dev"], d);
    git(["config", "user.name", "T"], d);
    fs.writeFileSync(path.join(d, "README.md"), "hi\n");
    git(["add", "-A"], d);
    git(["commit", "-m", "init"], d);
    return d;
  }

  function mgr(settings: TachyonConfig["settings"] = { worktree: { base } }) {
    return new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, occupancy: async () => undefined });
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "pl-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const runKey = (id: string) => `run-${id}`; // NAME_RE = /^[a-zA-Z].../ → must start with a letter

  it("1+2: a run allocates ONE worktree under run-<id>; sequential nodes reuse the SAME path", async () => {
    const m = mgr();
    const key = runKey("abc123");
    const branch = branchFor(key, { worktree: { base } }, {});
    expect(branch).toBe("tachyon/run-abc123");

    // node A spawns → allocate the run worktree
    const a = await m.ensure({ agent: key, branch, quarantineForLaunch: true });
    expect(a.created).toBe(true);
    expect(a.preparationLocked).toBe(true);
    expect(a.record.path).toBe(path.join(base, "h", key));
    // Workspace records run ownership before allowing any node spawn, then finalizes the receipt.
    await m.completePreparation(a.record);

    // node B spawns later in the same run → reuse the identical worktree, not a new one
    const b = await m.ensure({ agent: key, branch, prior: a.record });
    expect(b.created).toBe(false);
    expect(b.record.path).toBe(a.record.path);
  });

  it("3: hand-off — a file written by node A is visible to node B in the shared run worktree", async () => {
    const m = mgr();
    const key = runKey("handoff");
    const branch = branchFor(key, { worktree: { base } }, {});

    const a = await m.ensure({ agent: key, branch });
    // node A does its work in the worktree
    fs.writeFileSync(path.join(a.record.path, "from-node-a.txt"), "A was here\n");

    // node B re-resolves to the same worktree and sees A's work (state flows via the checkout)
    const b = await m.ensure({ agent: key, branch, prior: a.record });
    const seen = fs.readFileSync(path.join(b.record.path, "from-node-a.txt"), "utf8");
    expect(seen).toBe("A was here\n");
  });

  it("4: distinct runs get distinct worktrees (run isolation)", async () => {
    const m = mgr();
    const r1 = await m.ensure({ agent: runKey("one"), branch: branchFor(runKey("one"), { worktree: { base } }, {}) });
    const r2 = await m.ensure({ agent: runKey("two"), branch: branchFor(runKey("two"), { worktree: { base } }, {}) });
    expect(r1.record.path).not.toBe(r2.record.path);
  });

  it("5: cwd override (Mechanism B) returns the run worktree for ANY node, in front of resolveWorktreeCwd", async () => {
    const m = mgr();
    const key = runKey("override");
    const branch = branchFor(key, { worktree: { base } }, {});
    const run = (await m.ensure({ agent: key, branch })).record;

    // The Workspace-level override the plan proposes: a node that belongs to a pipeline run resolves
    // to the run's worktree, bypassing the stock per-agent resolver. Modeled inline here.
    const nodeToRun = new Map<string, WorktreeRecord>([
      ["research", run],
      ["implement", run],
      ["review", run],
    ]);
    async function resolveSpawnCwdForNode(name: string): Promise<{ cwd: string; worktree?: WorktreeRecord } | null> {
      const r = nodeToRun.get(name);
      if (r) return { cwd: r.path, worktree: r }; // override: run-scoped
      // non-pipeline agent → stock per-agent resolver (no worktree here → null/default)
      return resolveWorktreeCwd(
        { name, worktree: false, isRestart: false },
        { manager: m, settings: { worktree: { base } }, resolveParent: async () => ({ known: false }), runSetup: async () => {}, notify: () => {} },
      );
    }

    expect((await resolveSpawnCwdForNode("research"))?.cwd).toBe(run.path);
    expect((await resolveSpawnCwdForNode("implement"))?.cwd).toBe(run.path);
    expect((await resolveSpawnCwdForNode("review"))?.cwd).toBe(run.path);
    expect(await resolveSpawnCwdForNode("some-plain-agent")).toBeNull(); // untouched path
  });
});
