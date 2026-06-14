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

import { execFile } from "node:child_process";
import fs from "node:fs";
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

// ── Side-effecting git layer ─────────────────────────────────────────────────

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}
/** Runs git in a cwd. Resolves (never rejects) on a non-zero exit so callers branch on `code`; rejects only when git can't spawn (binary absent). */
export type GitExec = (args: string[], cwd: string) => Promise<GitResult>;

export function defaultGitExec(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("git binary not found"));
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

/** Dirty/divergence signal for the kill/dismiss confirmation. */
export interface WorktreeStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  detached: boolean;
  branch: string | null;
  aheadOfBase: number; // commits on HEAD not on baseRef
  unpushed: number; // commits not on the upstream; equals aheadOfBase-ish when no upstream
  hasUpstream: boolean;
}

export class WorktreeUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: "no-git" | "not-repo" | "unborn" | "bare" | "add-failed" | "reuse-invalid",
  ) {
    super(message);
    this.name = "WorktreeUnavailableError";
  }
}

export interface EnsureOptions {
  agent: string;
  branch: string; // already resolved via branchFor
  /** prior persisted record for this agent, if any — drives validated reuse */
  prior?: WorktreeRecord;
}

/**
 * Owns the side-effecting git mechanics. Pure decisions are the module functions above;
 * this serializes per-agent (a lock chain) so concurrent spawn/restart/remove never race
 * the same worktree, and translates every git failure into a typed fallback signal so the
 * caller can fall back to the workspace root instead of blocking the agent.
 */
export class WorktreeManager {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly opts: {
      workspaceRoot: string;
      wsHash: string;
      getSettings: () => TachyonConfig["settings"];
      git?: GitExec;
      pathExists?: (p: string) => boolean;
      now?: () => string;
    },
  ) {}

  private get git(): GitExec {
    return this.opts.git ?? defaultGitExec;
  }
  private exists(p: string): boolean {
    return (this.opts.pathExists ?? fs.existsSync)(p);
  }
  private nowIso(): string {
    return (this.opts.now ?? (() => new Date().toISOString()))();
  }

  /** Serialize all worktree ops for one agent (spawn/restart/setup/remove). */
  private withLock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(agent) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      agent,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** True when the workspace is a usable git repo with at least one commit (a worktree needs a HEAD to fork from). */
  async isUsableRepo(): Promise<{ ok: true } | { ok: false; reason: WorktreeUnavailableError["reason"]; message: string }> {
    let gitDir: GitResult;
    try {
      gitDir = await this.git(["rev-parse", "--git-dir"], this.opts.workspaceRoot);
    } catch {
      return { ok: false, reason: "no-git", message: "git binary not found" };
    }
    if (gitDir.code !== 0) return { ok: false, reason: "not-repo", message: "not a git repository" };
    const bare = await this.git(["rev-parse", "--is-bare-repository"], this.opts.workspaceRoot);
    if (bare.stdout.trim() === "true") return { ok: false, reason: "bare", message: "bare repositories cannot host a worktree" };
    // unborn = a repo with no commits → no HEAD to fork a worktree from.
    const headRef = await this.git(["rev-parse", "HEAD"], this.opts.workspaceRoot);
    if (headRef.code !== 0) return { ok: false, reason: "unborn", message: "repository has no commits yet" };
    return { ok: true };
  }

  /**
   * Ensure agent's worktree exists and is on `branch`; return its record. Reuses a validated
   * prior worktree (same repo + branch), else creates per the branch-state matrix. Throws
   * WorktreeUnavailableError on any git problem so the caller falls back to the workspace root.
   */
  ensure(o: EnsureOptions): Promise<WorktreeRecord> {
    return this.withLock(o.agent, () => this.ensureLocked(o));
  }

  private async ensureLocked(o: EnsureOptions): Promise<WorktreeRecord> {
    const usable = await this.isUsableRepo();
    if (!usable.ok) throw new WorktreeUnavailableError(usable.message, usable.reason);

    // Validate the branch name authoritatively (the literal pre-filter ran at config time).
    const fmt = await this.git(gitArgs.checkRefFormat(o.branch), this.opts.workspaceRoot);
    if (fmt.code !== 0) throw new WorktreeUnavailableError(`invalid branch name '${o.branch}'`, "add-failed");

    await this.git(gitArgs.prune(), this.opts.workspaceRoot);
    const wtPath = pathFor(resolveBase(this.opts.getSettings()), this.opts.wsHash, o.agent);

    // Reuse path — only when validated.
    if (this.exists(wtPath)) {
      const repoCommon = (await this.git(["rev-parse", "--git-common-dir"], this.opts.workspaceRoot)).stdout.trim();
      const wtCommonProbe = await this.git(["rev-parse", "--git-common-dir"], wtPath);
      const wtCommon = wtCommonProbe.code === 0 ? path.resolve(wtPath, wtCommonProbe.stdout.trim()) : null;
      const curProbe = await this.git(gitArgs.currentBranch(), wtPath);
      const cur = curProbe.code === 0 && curProbe.stdout.trim() !== "HEAD" ? curProbe.stdout.trim() : null;
      const reuse = validateReuse({
        repoCommonDir: path.resolve(this.opts.workspaceRoot, repoCommon),
        worktreeCommonDir: wtCommon,
        currentBranch: cur,
        expectedBranch: o.branch,
      });
      if (!reuse.ok) throw new WorktreeUnavailableError(`cannot reuse worktree at ${wtPath}: ${reuse.reason}`, "reuse-invalid");
      return (
        o.prior ?? {
          path: wtPath,
          branch: o.branch,
          tachyonCreatedBranch: false, // unknown on reuse without a prior record — assume not owned (safe for cleanup)
          baseRef: (await this.git(gitArgs.headRef(), wtPath)).stdout.trim(),
          createdAt: this.nowIso(),
        }
      );
    }

    // Create — resolve the branch state, then act.
    const exists = (await this.git(gitArgs.branchExists(o.branch), this.opts.workspaceRoot)).code === 0;
    let state: BranchState = "absent";
    if (exists) state = (await this.branchCheckedOutElsewhere(o.branch)) ? "checked-out-elsewhere" : "exists-free";
    const action = actionForBranchState(o.branch, state);
    if (action.kind === "fail") throw new WorktreeUnavailableError(action.reason, "add-failed");

    const baseRef = (await this.git(gitArgs.headRef(), this.opts.workspaceRoot)).stdout.trim();
    const addArgs = action.kind === "create" ? gitArgs.addNewBranch(wtPath, o.branch, baseRef) : gitArgs.attachBranch(wtPath, o.branch);
    const add = await this.git(addArgs, this.opts.workspaceRoot);
    if (add.code !== 0) throw new WorktreeUnavailableError(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`, "add-failed");

    return { path: wtPath, branch: o.branch, tachyonCreatedBranch: action.tachyonCreatedBranch, baseRef, createdAt: this.nowIso() };
  }

  /** Is `branch` checked out in some OTHER worktree / the main tree? (parse `worktree list --porcelain`) */
  private async branchCheckedOutElsewhere(branch: string): Promise<boolean> {
    const out = await this.git(gitArgs.listWorktrees(), this.opts.workspaceRoot);
    if (out.code !== 0) return false;
    return out.stdout.split("\n").some((l) => l.trim() === `branch refs/heads/${branch}`);
  }

  /** Dirty/divergence signal for the cleanup confirmation. Best-effort: a failed probe reads as zero/false. */
  async status(cwd: string, baseRef: string): Promise<WorktreeStatus> {
    const porcelain = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
    let staged = 0,
      unstaged = 0,
      untracked = 0,
      conflicts = 0;
    for (const line of porcelain.stdout.split("\n")) {
      if (line.length < 2) continue;
      const x = line[0],
        y = line[1];
      if (x === "?" && y === "?") untracked++;
      else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) conflicts++;
      else {
        if (x !== " " && x !== "?") staged++;
        if (y !== " " && y !== "?") unstaged++;
      }
    }
    const curProbe = await this.git(gitArgs.currentBranch(), cwd);
    const branchName = curProbe.code === 0 ? curProbe.stdout.trim() : null;
    const detached = branchName === "HEAD" || branchName === null;
    const ahead = await this.git(["rev-list", "--count", `${baseRef}..HEAD`], cwd);
    const aheadOfBase = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim() || "0", 10) || 0 : 0;
    const up = await this.git(["rev-list", "--count", "@{upstream}..HEAD"], cwd);
    const hasUpstream = up.code === 0;
    const unpushed = hasUpstream ? Number.parseInt(up.stdout.trim() || "0", 10) || 0 : aheadOfBase;
    return { staged, unstaged, untracked, conflicts, detached, branch: detached ? null : branchName, aheadOfBase, unpushed, hasUpstream };
  }

  /**
   * Remove the worktree (always `git worktree remove --force`), and the branch ONLY when it
   * was Tachyon-created AND the caller confirmed deletion. A human branch is never force-deleted.
   */
  remove(rec: WorktreeRecord, deleteBranch: boolean): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
    return this.withLock(rec.path, async () => {
      const rm = await this.git(gitArgs.remove(rec.path), this.opts.workspaceRoot);
      if (rm.code !== 0) return { removed: false, branchDeleted: false, error: rm.stderr.trim() || rm.stdout.trim() };
      let branchDeleted = false;
      if (deleteBranch && rec.tachyonCreatedBranch) {
        const del = await this.git(gitArgs.deleteBranch(rec.branch), this.opts.workspaceRoot);
        branchDeleted = del.code === 0;
      }
      await this.git(gitArgs.prune(), this.opts.workspaceRoot);
      return { removed: true, branchDeleted };
    });
  }

  /**
   * Force-delete a branch standalone — used ONLY after the human's explicit 2nd confirm to
   * delete a PRE-EXISTING (human) branch whose worktree was already removed. Never called
   * automatically; `remove()` still refuses to touch a non-Tachyon branch on its own.
   */
  async deleteBranch(branch: string): Promise<boolean> {
    return (await this.git(gitArgs.deleteBranch(branch), this.opts.workspaceRoot)).code === 0;
  }

  /** Pure path resolver exposed for C2 (diff-review) + the kill flow — never recomputes branch. */
  pathForAgent(agent: string): string {
    return pathFor(resolveBase(this.opts.getSettings()), this.opts.wsHash, agent);
  }
}

/** Minimal agent shape the spawn-cwd resolver needs (avoids importing AgentManager → no cycle). */
export interface WorktreeSpawnCtx {
  name: string;
  worktree?: boolean;
  branch?: string;
  worktreeSetup?: string[];
  /** lineage parent — a sub-agent inherits the parent's cwd, ignoring its own worktree flag */
  parent?: string;
  /** restart/resume — reuse the worktree, never re-run setup */
  isRestart: boolean;
}

export interface WorktreeResolveDeps {
  manager: WorktreeManager;
  settings: TachyonConfig["settings"];
  /** the cwd the parent agent is running in (its worktree, or the root) — for sub-agent inheritance */
  parentCwd: (parent: string) => string | undefined;
  /** the prior persisted worktree record for this agent (validated reuse) */
  priorRecord?: WorktreeRecord;
  /** run worktreeSetup in the fresh worktree (sequential/stop-on-failure/non-fatal) — only on create */
  runSetup: (rec: WorktreeRecord, setup: string[]) => Promise<void>;
  notify: (message: string, level?: "info" | "warn" | "error") => void;
  pathExists?: (p: string) => boolean;
}

/**
 * spec 210 — decide the cwd a session is born in. Returns `null` to mean "use the default
 * cwd" (workspace root / def.cwd), so the AgentManager never has to know about worktrees.
 * Side-effecting via deps (so it unit-tests with git mocked):
 *   - sub-agent (parent set): inherit the parent's cwd; a `worktree:true` is a no-op + warning.
 *   - top-level + worktree:true: ensure() the worktree, run setup once on create, return its path;
 *     any git problem (no-git / not-repo / unborn / bare / add-fail / reuse-invalid) → notice + null
 *     (fall back to the root, never block the agent).
 *   - otherwise: null (default).
 */
export async function resolveWorktreeCwd(
  ctx: WorktreeSpawnCtx,
  deps: WorktreeResolveDeps,
): Promise<{ cwd: string; worktree?: WorktreeRecord } | null> {
  if (ctx.parent) {
    if (ctx.worktree) {
      deps.notify(`'${ctx.name}' is a sub-agent — it shares its parent's worktree; spawn it top-level to isolate it`, "warn");
    }
    const inherited = deps.parentCwd(ctx.parent);
    return inherited ? { cwd: inherited } : null; // null → AgentManager uses the root
  }
  if (!ctx.worktree) return null;

  let branch: string;
  try {
    branch = branchFor(ctx.name, deps.settings, { branch: ctx.branch });
  } catch (err) {
    deps.notify(`worktree disabled for '${ctx.name}': ${err instanceof Error ? err.message : String(err)}`, "error");
    return null;
  }
  const exists = (deps.pathExists ?? fs.existsSync)(deps.manager.pathForAgent(ctx.name));
  try {
    const rec = await deps.manager.ensure({ agent: ctx.name, branch, prior: deps.priorRecord });
    // Setup runs ONCE, only when we freshly created the checkout (not reuse, not restart).
    if (!exists && !ctx.isRestart && ctx.worktreeSetup && ctx.worktreeSetup.length > 0) {
      await deps.runSetup(rec, ctx.worktreeSetup);
    }
    return { cwd: rec.path, worktree: rec };
  } catch (err) {
    const reason = err instanceof WorktreeUnavailableError ? err.message : err instanceof Error ? err.message : String(err);
    deps.notify(`'${ctx.name}' falling back to the workspace root — ${reason}`, "warn");
    return null;
  }
}
