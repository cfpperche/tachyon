/**
 * Per-agent git worktree isolation (spec 210 / C1). Each opt-in agent runs in its
 * own worktree on its own branch, so parallel agents never clobber each other's
 * files. A worktree is a pure git mechanism — runtime- and kind-agnostic; this only
 * changes the cwd a tmux session is born in.
 *
 * Mirrors src/resume/: the PURE resolvers (path/branch resolution, git-arg builders,
 * the branch-state→action decision, the reuse-validation predicate) live here as
 * standalone functions and unit-test with no real git; the side-effecting git calls
 * (ensure/status/remove, under a per-agent lock) plug in on top in Task 3.
 */

import os from "node:os";
import path from "node:path";
import type { AgentDef, TachyonConfig } from "../config/loadConfig.js";

/** Persisted source of truth for cleanup + the future diff-review (C2). Never recomputed from (possibly drifted) config. */
export interface WorktreeRecord {
  /** absolute worktree path (the agent's cwd) */
  path: string;
  /** the branch checked out in it */
  branch: string;
  /** true only when Tachyon created the branch (`git worktree add -b`) — gates `branch -D` on cleanup */
  tachyonCreatedBranch: boolean;
  /** the ref the branch was forked from (HEAD at create) — the base for ahead/behind in status */
  baseRef: string;
  createdAt: string;
}

/** Whether the resolved branch already exists, and if so whether it's free to attach. */
export type BranchState = "absent" | "exists-free" | "checked-out-elsewhere";

/** What ensure() should do for a resolved (branch, path), derived purely from branch state. */
export type WorktreeAction =
  | { kind: "create"; tachyonCreatedBranch: true } // branch absent → `git worktree add -b`
  | { kind: "attach"; tachyonCreatedBranch: false } // branch exists, free → `git worktree add <path> <branch>`
  | { kind: "fail"; reason: string }; // branch checked out elsewhere → never clobber

/**
 * Location root for all worktrees: `settings.worktree.base` (with `~` expanded) or the
 * XDG-aware default `${XDG_CACHE_HOME:-~/.cache}/tachyon/worktrees`. Global-only by decision.
 */
export function resolveBase(
  settings: TachyonConfig["settings"],
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const configured = settings.worktree?.base;
  if (configured) return expandHome(configured, homeDir);
  const xdg = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim().length > 0 ? env.XDG_CACHE_HOME : path.join(homeDir, ".cache");
  return path.join(xdg, "tachyon", "worktrees");
}

function expandHome(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2));
  return p;
}

/** Central, wsHash-keyed worktree path: `<base>/<wsHash>/<agent>`. Agent names are already fs-safe (NAME_RE). */
export function pathFor(base: string, wsHash: string, agent: string): string {
  return path.join(base, wsHash, agent);
}

/**
 * Resolve the branch name: per-agent `branch` (literal) > global `settings.worktree.branch`
 * template with `{agent}` substituted > `tachyon/<agent>`. The template MUST contain
 * `{agent}` (config rejects one without it; we throw defensively if it slips through, since
 * a template without it would collide every agent onto one branch). The result is validated
 * authoritatively via `git check-ref-format` in ensure() — this is pure string resolution.
 */
export function branchFor(agent: string, settings: TachyonConfig["settings"], agentDef: Pick<AgentDef, "branch">): string {
  if (agentDef.branch) return agentDef.branch;
  const template = settings.worktree?.branch;
  if (template) {
    if (!template.includes("{agent}")) throw new Error(`worktree branch template '${template}' is missing the {agent} placeholder`);
    return template.replaceAll("{agent}", agent);
  }
  return `tachyon/${agent}`;
}

/**
 * Decide what ensure() does, given the resolved branch's state. Pure: the caller probes git
 * for the state, then this maps it to an action (so the matrix is unit-tested without git).
 */
export function actionForBranchState(branch: string, state: BranchState): WorktreeAction {
  switch (state) {
    case "absent":
      return { kind: "create", tachyonCreatedBranch: true };
    case "exists-free":
      return { kind: "attach", tachyonCreatedBranch: false };
    case "checked-out-elsewhere":
      return {
        kind: "fail",
        reason: `branch '${branch}' is already checked out in another worktree or the main tree — refusing to clobber it`,
      };
  }
}

/**
 * Reuse is valid ONLY when the existing path is a worktree of THIS repo (common dir matches)
 * AND it's on the expected branch. Probed values come from git; this is the pure predicate so
 * the "don't silently reuse stale state" rule is unit-tested. `repoCommonDir`/`worktreeCommonDir`
 * are the absolute `git rev-parse --git-common-dir` of the main repo and of the candidate path.
 */
export function validateReuse(args: {
  repoCommonDir: string;
  worktreeCommonDir: string | null; // null = path isn't a git worktree
  currentBranch: string | null; // null = detached or unresolved
  expectedBranch: string;
}): { ok: true } | { ok: false; reason: string } {
  const { repoCommonDir, worktreeCommonDir, currentBranch, expectedBranch } = args;
  if (worktreeCommonDir === null) return { ok: false, reason: "path exists but is not a git worktree" };
  if (path.resolve(worktreeCommonDir) !== path.resolve(repoCommonDir)) {
    return { ok: false, reason: "worktree belongs to a different repository (git common-dir mismatch)" };
  }
  if (currentBranch === null) return { ok: false, reason: "worktree is detached or its branch could not be resolved" };
  if (currentBranch !== expectedBranch) {
    return { ok: false, reason: `worktree is on '${currentBranch}', expected '${expectedBranch}'` };
  }
  return { ok: true };
}

// ── Pure git-arg builders (no execution) ─────────────────────────────────────
// One place owns the exact argv so the side-effecting layer and the tests agree.

export const gitArgs = {
  prune: (): string[] => ["worktree", "prune"],
  /** create a NEW branch off baseRef and check it out in a fresh worktree */
  addNewBranch: (wtPath: string, branch: string, baseRef: string): string[] => ["worktree", "add", "-b", branch, wtPath, baseRef],
  /** attach an EXISTING branch into a fresh worktree (no -b) */
  attachBranch: (wtPath: string, branch: string): string[] => ["worktree", "add", wtPath, branch],
  remove: (wtPath: string): string[] => ["worktree", "remove", "--force", wtPath],
  deleteBranch: (branch: string): string[] => ["branch", "-D", branch],
  checkRefFormat: (branch: string): string[] => ["check-ref-format", "--branch", branch],
  /** absolute common git dir — identical for every worktree of the same repo */
  commonDir: (): string[] => ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
  currentBranch: (): string[] => ["rev-parse", "--abbrev-ref", "HEAD"],
  headRef: (): string[] => ["rev-parse", "HEAD"],
  /** branch existence: exits 0 if the ref exists */
  branchExists: (branch: string): string[] => ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
  /** list worktrees in a parseable form (to find if a branch is checked out elsewhere) */
  listWorktrees: (): string[] => ["worktree", "list", "--porcelain"],
} as const;
