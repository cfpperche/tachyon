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
import { parseNameStatus, mergeChanges, type ChangedFile } from "./review.js";
import type { VerifyState } from "./verify.js";
import type { WorktreeEvidence } from "./evidence.js";
import { resolveGitBinary, gitNotFoundError } from "./gitBinary.js";

/** Persisted source of truth for cleanup + the diff-review (C2) + the verify-gate (C3). Never recomputed from (possibly drifted) config. */
export interface WorktreeRecord {
  /** absolute worktree path (the agent's cwd) */
  path: string;
  /** the branch checked out in it */
  branch: string;
  /** true only when Tachyon created the branch (`git worktree add -b`) — gates `branch -D` on cleanup */
  tachyonCreatedBranch: boolean;
  /** the ref the branch was forked from (HEAD at create) — the base for ahead/behind in status */
  baseRef: string;
  /** spec 223 — the BRANCH the worktree was forked from (the main checkout's branch at create), the
   *  PR base. Persisted at create so it's exact; absent for a detached-HEAD source or a pre-223 record
   *  (then a PR falls back to a best-effort name-rev guess). */
  baseBranch?: string;
  createdAt: string;
  /** spec 214 (C3) — last verify-gate result, keyed to the commit it ran against (staleness). */
  verify?: VerifyState;
  /** spec 273 — the neutral non-binary evidence channel (bounded; HEAD-only staleness, never a gate). */
  evidence?: WorktreeEvidence[];
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

function listedWorktree(output: string, targetPath: string): { locked: boolean } | undefined {
  const target = path.resolve(targetPath);
  for (const block of output.split(/\n\n+/u)) {
    const lines = block.split("\n");
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine || path.resolve(worktreeLine.slice("worktree ".length)) !== target) continue;
    return { locked: lines.some((line) => line === "locked" || line.startsWith("locked ")) };
  }
  return undefined;
}

// ── Pure git-arg builders (no execution) ─────────────────────────────────────
// One place owns the exact argv so the side-effecting layer and the tests agree.

export const gitArgs = {
  prune: (): string[] => ["worktree", "prune"],
  /** create a NEW branch off baseRef and check it out in a fresh worktree */
  addNewBranch: (wtPath: string, branch: string, baseRef: string): string[] => ["worktree", "add", "-b", branch, wtPath, baseRef],
  /** A quarantined fresh checkout starts Git-locked until durable launch ownership is recorded. */
  addNewBranchLocked: (wtPath: string, branch: string, baseRef: string): string[] => ["worktree", "add", "--lock", "-b", branch, wtPath, baseRef],
  /** attach an EXISTING branch into a fresh worktree (no -b) */
  attachBranch: (wtPath: string, branch: string): string[] => ["worktree", "add", wtPath, branch],
  attachBranchLocked: (wtPath: string, branch: string): string[] => ["worktree", "add", "--lock", wtPath, branch],
  // Keep this compatible with Git versions that support `worktree lock` but predate `--reason`.
  lock: (wtPath: string): string[] => ["worktree", "lock", wtPath],
  unlock: (wtPath: string): string[] => ["worktree", "unlock", wtPath],
  /** Default force for occupancy-checked product cleanup. Soft (no --force) lets Git refuse a dirty tree. */
  remove: (wtPath: string, force = true): string[] =>
    force ? ["worktree", "remove", "--force", wtPath] : ["worktree", "remove", wtPath],
  /** SAFE delete — git refuses if the branch isn't fully merged into HEAD/upstream (no work lost). */
  deleteBranchSafe: (branch: string): string[] => ["branch", "-d", branch],
  /** FORCE delete — only after an explicit human confirm (loses unmerged commits). */
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
  /** C2 (spec 213): tracked changes vs baseRef (working-tree compare), name+status. `-z` =
   *  NUL-delimited, UNquoted paths (git would otherwise C-quote non-ASCII/space/tab paths). */
  diffNameStatus: (baseRef: string): string[] => ["diff", "-z", "--name-status", "--find-renames", "--find-copies", baseRef],
  /** C2: untracked, not-ignored files (NUL-delimited) */
  lsOthers: (): string[] => ["ls-files", "-z", "--others", "--exclude-standard"],
  /** C2: a file's content at a ref (the diff's base side) */
  showFile: (ref: string, file: string): string[] => ["show", `${ref}:${file}`],
} as const;

// ── Side-effecting git layer ─────────────────────────────────────────────────

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}
/** Runs git in a cwd. Resolves (never rejects) on a non-zero exit so callers branch on `code`; rejects only when git can't spawn (binary absent). */
export type GitExec = (args: string[], cwd: string) => Promise<GitResult>;
export type WorktreeOccupancy = { state: "live" | "pending" | "dirty"; agent: string; cwd: string };
export type WorktreeOccupancyProbe = (worktreePath: string) => Promise<WorktreeOccupancy | undefined>;

export function createGitExec(resolveBinary: () => string): GitExec {
  return (args, cwd) => new Promise((resolve, reject) => {
    execFile(resolveBinary(), args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(gitNotFoundError());
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

/** Headless fallback for callers without a shell settings port. */
export const defaultGitExec: GitExec = createGitExec(() => resolveGitBinary());

/**
 * C2 (spec 213) — standalone `git show <ref>:<file>` in a cwd, for the diff content provider
 * (which is global, not bound to a WorktreeManager instance). "" on any failure (added/binary/
 * removed-worktree), so an added file's base side just renders empty. git is injectable for tests.
 */
export async function worktreeShowFile(cwd: string, ref: string, file: string, git: GitExec = defaultGitExec): Promise<string> {
  try {
    const r = await git(gitArgs.showFile(ref, file), cwd);
    return r.code === 0 ? r.stdout : "";
  } catch {
    return "";
  }
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
    public readonly reason: "no-git" | "not-repo" | "unborn" | "bare" | "add-failed" | "reuse-invalid" | "preparation-failed" | "recovery-preserved",
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
  /** Acquire a durable Git quarantine lock for this launch attempt, including validated reuse.
   * AgentManager releases it only after ownership/delegation records are durable. */
  quarantineForLaunch?: boolean;
  /**
   * Run worktreeSetup in the freshly-created checkout — invoked by ensure() UNDER the
   * per-agent lock, only when it created the worktree, so a concurrent spawn can't reuse
   * the path and start before setup finishes (review fix). Omit on restart/reuse.
   */
  runSetup?: (rec: WorktreeRecord) => Promise<void>;
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
      occupancy?: WorktreeOccupancyProbe;
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
  private withLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
    const key = this.canonicalLockKey(worktreePath);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Realpath the nearest existing ancestor so symlinked worktree bases cannot create a second mutex key. */
  private canonicalLockKey(value: string): string {
    let cursor = path.resolve(value);
    const suffix: string[] = [];
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
    try { return path.join(fs.realpathSync(cursor), ...suffix); }
    catch { return path.resolve(value); }
  }

  /** Serialize custom worktree mutations with ensure/remove for this agent's deterministic worktree path. */
  withAgentPathLock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const key = pathFor(resolveBase(this.opts.getSettings()), this.opts.wsHash, agent);
    return this.withPathLock(key, fn);
  }

  /** Serialize by the canonical worktree path used by ensure/remove and Delivery verification. */
  withPathLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock(path.resolve(worktreePath), fn);
  }

  /** True when the workspace is a usable git repo with at least one commit (a worktree needs a HEAD to fork from). */
  async isUsableRepo(): Promise<{ ok: true } | { ok: false; reason: WorktreeUnavailableError["reason"]; message: string }> {
    try {
      const gitDir = await this.git(["rev-parse", "--git-dir"], this.opts.workspaceRoot);
      if (gitDir.code !== 0) return { ok: false, reason: "not-repo", message: "not a git repository" };
      const bare = await this.git(["rev-parse", "--is-bare-repository"], this.opts.workspaceRoot);
      if (bare.code !== 0) return { ok: false, reason: "not-repo", message: "cannot inspect repository type" };
      if (bare.stdout.trim() === "true") return { ok: false, reason: "bare", message: "bare repositories cannot host a worktree" };
      // unborn = a repo with no commits → no HEAD to fork a worktree from.
      const headRef = await this.git(["rev-parse", "HEAD"], this.opts.workspaceRoot);
      if (headRef.code !== 0) return { ok: false, reason: "unborn", message: "repository has no commits yet" };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "no-git", message: err instanceof Error ? err.message : "git binary not found" };
    }
  }

  /**
   * Ensure agent's worktree exists and is on `branch`; return its record. Reuses a validated
   * prior worktree (same repo + branch), else creates per the branch-state matrix. Throws
   * WorktreeUnavailableError on git problems; recovery/quarantine failures are explicitly
   * distinguished so launch callers can fail closed instead of falling back to the shared root.
   */
  ensure(o: EnsureOptions): Promise<{ record: WorktreeRecord; created: boolean; initialHead?: string; preparationLocked?: boolean }> {
    // Lock by the WORKTREE PATH (deterministic per agent) — the same key remove() uses —
    // so ensure/remove for one agent never race (review fix: keys were agent vs path).
    const key = o.prior?.path ?? pathFor(resolveBase(this.opts.getSettings()), this.opts.wsHash, o.agent);
    return this.withLock(key, () => this.ensureLocked(o));
  }

  /**
   * Preserve a fresh `ensure()` when later launch preparation fails. Even an exact HEAD plus a clean
   * status is only a snapshot: a setup child or same-user process can create ignored work between the
   * probe and `git worktree remove`, which would silently delete it. Automatic failure compensation is
   * therefore deliberately non-destructive; the error exposes the recovery path for explicit cleanup.
   */
  rollbackCreated(rec: WorktreeRecord, initialHead: string | undefined, expectedPreparedHead: string): Promise<void> {
    return this.withLock(rec.path, async () => {
      const initial = initialHead ? `; initial HEAD ${initialHead}` : "";
      throw new Error(
        `fresh worktree recovery state was preserved at ${rec.path} ` +
          `(prepared HEAD ${expectedPreparedHead}${initial}); automatic rollback cannot exclude a concurrent ignored-file write`,
      );
    });
  }

  /**
   * Preserve an already-existing worktree when launch preparation advanced its HEAD. A clean-status
   * probe followed by `reset --hard` has the same check/use race as removal, so automatic compensation
   * never rewinds a checkout that another process could still be writing. Equal HEADs still retain
   * the quarantine receipt and therefore return an explicit recovery diagnostic.
   */
  rollbackPreparation(rec: WorktreeRecord, beforeHead: string, expectedPreparedHead: string): Promise<void> {
    return this.withLock(rec.path, async () => {
      if (beforeHead === expectedPreparedHead) {
        throw new Error(
          `prepared worktree recovery state was preserved at ${rec.path} ` +
            `(HEAD remained ${expectedPreparedHead}); its launch quarantine still requires explicit recovery`,
        );
      }
      throw new Error(
        `prepared worktree recovery state was preserved at ${rec.path} ` +
          `(HEAD advanced from ${beforeHead} to ${expectedPreparedHead}); automatic reset cannot exclude a concurrent write`,
      );
    });
  }

  /**
   * Mark a quarantined checkout reusable only after its caller has durably recorded launch
   * ownership (and, for a gate, its delegation record). Until this point Git's worktree lock is a
   * crash-safe quarantine receipt, not an authorization for any destructive cleanup.
   */
  completePreparation(rec: WorktreeRecord): Promise<void> {
    return this.withLock(rec.path, async () => {
      const unlock = await this.git(gitArgs.unlock(rec.path), this.opts.workspaceRoot);
      if (unlock.code !== 0) {
        throw new Error(`prepared worktree could not be unlocked: ${unlock.stderr.trim() || unlock.stdout.trim()}`);
      }
    });
  }

  /** Reconcile the narrow crash window after quarantine unlock but before the durable ready-state
   * write. A surviving lock is not auto-recovered: it still requires explicit human inspection.
   * This method only proves that an already-unlocked checkout remains the expected clean branch/tip. */
  completePersistedPreparation(rec: WorktreeRecord): Promise<void> {
    return this.withLock(rec.path, async () => {
      if (!this.exists(rec.path)) throw new Error(`persisted worktree checkout is missing: ${rec.path}`);
      const listedProbe = await this.git(gitArgs.listWorktrees(), this.opts.workspaceRoot);
      if (listedProbe.code !== 0) throw new Error(`persisted worktree metadata could not be inspected: ${rec.path}`);
      const listed = listedWorktree(listedProbe.stdout, rec.path);
      if (!listed) throw new Error(`persisted worktree is not registered with Git: ${rec.path}`);
      if (listed.locked) {
        throw new Error(`persisted worktree remains Git-locked and requires explicit recovery: ${rec.path}`);
      }

      const repoCommon = (await this.git(["rev-parse", "--git-common-dir"], this.opts.workspaceRoot)).stdout.trim();
      const wtCommonProbe = await this.git(["rev-parse", "--git-common-dir"], rec.path);
      const branchProbe = await this.git(gitArgs.currentBranch(), rec.path);
      const reuse = validateReuse({
        repoCommonDir: path.resolve(this.opts.workspaceRoot, repoCommon),
        worktreeCommonDir: wtCommonProbe.code === 0 ? path.resolve(rec.path, wtCommonProbe.stdout.trim()) : null,
        currentBranch: branchProbe.code === 0 && branchProbe.stdout.trim() !== "HEAD" ? branchProbe.stdout.trim() : null,
        expectedBranch: rec.branch,
      });
      if (!reuse.ok) throw new Error(`persisted worktree recovery validation failed at ${rec.path}: ${reuse.reason}`);
      const headProbe = await this.git(gitArgs.headRef(), rec.path);
      if (headProbe.code !== 0 || headProbe.stdout.trim() !== rec.baseRef) {
        throw new Error(`persisted worktree HEAD drifted before ready-state recovery: ${rec.path}`);
      }
      const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], rec.path);
      if (status.code !== 0 || status.stdout.length > 0) {
        throw new Error(`persisted worktree is not clean enough for automatic ready-state recovery: ${rec.path}`);
      }
    });
  }

  /** `created` = we ran `git worktree add` (a fresh checkout → worktreeSetup should run); false on validated reuse. */
  private async ensureLocked(o: EnsureOptions): Promise<{ record: WorktreeRecord; created: boolean; initialHead?: string; preparationLocked?: boolean }> {
    const wtPath = o.prior?.path ?? pathFor(resolveBase(this.opts.getSettings()), this.opts.wsHash, o.agent);
    const usable = await this.isUsableRepo();
    if (!usable.ok) {
      throw new WorktreeUnavailableError(
        usable.message,
        o.quarantineForLaunch && (o.prior !== undefined || this.exists(wtPath)) ? "recovery-preserved" : usable.reason,
      );
    }

    await this.git(gitArgs.prune(), this.opts.workspaceRoot);
    // A persisted record remains the source of truth across settings.worktree.base changes. Cleanup,
    // restart and recovery must inspect the checkout actually owned by the ledger, not a newly-derived path.

    // Git's administrative metadata is authoritative even when the checkout directory was removed
    // or its branch became unreadable. Detect a surviving quarantine receipt before any path/branch
    // validation can downgrade it to an ordinary fallback-to-root error.
    const listedProbe = await this.git(gitArgs.listWorktrees(), this.opts.workspaceRoot);
    if (listedProbe.code !== 0 && o.quarantineForLaunch) {
      throw new WorktreeUnavailableError(`cannot inspect Git worktree quarantine state for ${wtPath}`, "recovery-preserved");
    }
    const listed = listedProbe.code === 0 ? listedWorktree(listedProbe.stdout, wtPath) : undefined;
    if (listed?.locked) {
      throw new WorktreeUnavailableError(
        `cannot reuse preserved worktree at ${wtPath}: its Git preparation lock is still present; inspect it and unlock explicitly`,
        "recovery-preserved",
      );
    }
    if (listed && !this.exists(wtPath) && o.quarantineForLaunch) {
      throw new WorktreeUnavailableError(
        `cannot prepare worktree at ${wtPath}: Git metadata survives but the checkout path is missing; inspect and recover it explicitly`,
        "recovery-preserved",
      );
    }

    // Validate the requested branch only after preserved metadata/receipts have been classified.
    // A config drift to an invalid template must never hide an existing locked checkout and fall back.
    const fmt = await this.git(gitArgs.checkRefFormat(o.branch), this.opts.workspaceRoot);
    if (fmt.code !== 0) {
      throw new WorktreeUnavailableError(
        `invalid branch name '${o.branch}'`,
        o.quarantineForLaunch && (listed !== undefined || this.exists(wtPath) || o.prior !== undefined)
          ? "recovery-preserved"
          : "add-failed",
      );
    }

    // Reuse path — only when validated.
    if (this.exists(wtPath)) {
      const lockPathProbe = await this.git(["rev-parse", "--git-path", "locked"], wtPath);
      const lockPath = lockPathProbe.code === 0 && lockPathProbe.stdout.trim()
        ? path.resolve(wtPath, lockPathProbe.stdout.trim())
        : undefined;
      if (lockPath && fs.existsSync(lockPath)) {
        throw new WorktreeUnavailableError(
          `cannot reuse preserved worktree at ${wtPath}: its Git preparation lock is still present; inspect it and unlock explicitly`,
          "recovery-preserved",
        );
      }
      if (!lockPath && o.quarantineForLaunch) {
        throw new WorktreeUnavailableError(`cannot inspect preparation lock for worktree at ${wtPath}`, "recovery-preserved");
      }
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
      if (!reuse.ok) {
        throw new WorktreeUnavailableError(
          `cannot reuse worktree at ${wtPath}: ${reuse.reason}`,
          o.quarantineForLaunch ? "recovery-preserved" : "reuse-invalid",
        );
      }
      // Quarantined checkouts are unlocked only after durable launch ownership is recorded. A
      // surviving lock is durable evidence of an interrupted attempt; never turn that preserved
      // state into a normal retry implicitly.
      if (!lockPath) {
        throw new WorktreeUnavailableError(
          `cannot inspect preparation lock for worktree at ${wtPath}`,
          o.quarantineForLaunch ? "recovery-preserved" : "reuse-invalid",
        );
      }
      if (o.quarantineForLaunch) {
        const locked = await this.git(gitArgs.lock(wtPath), this.opts.workspaceRoot);
        if (locked.code !== 0) {
          throw new WorktreeUnavailableError(
            `cannot quarantine worktree at ${wtPath} for launch: ${locked.stderr.trim() || locked.stdout.trim()}`,
            "recovery-preserved",
          );
        }
        // Close the validation-to-lock race. The Git lock is a durable quarantine receipt, not a
        // filesystem mutex, so re-read branch and HEAD and leave recovery state locked on drift.
        const lockedBranch = await this.git(gitArgs.currentBranch(), wtPath);
        const lockedHead = await this.git(gitArgs.headRef(), wtPath);
        if (lockedBranch.code !== 0 || lockedBranch.stdout.trim() !== o.branch || lockedHead.code !== 0 || !lockedHead.stdout.trim()) {
          throw new WorktreeUnavailableError(
            `worktree at ${wtPath} changed while launch quarantine was acquired; recovery state remains locked`,
            "recovery-preserved",
          );
        }
      }
      // Return a record reflecting the CURRENT validated state (path + branch just verified),
      // carrying forward only the prior's ownership/baseRef/createdAt — never the prior's
      // possibly-drifted path/branch (review fix: stale prior could mis-target cleanup).
      const currentHeadProbe = await this.git(gitArgs.headRef(), wtPath);
      if (currentHeadProbe.code !== 0 || !currentHeadProbe.stdout.trim()) {
        throw new WorktreeUnavailableError(
          o.quarantineForLaunch
            ? `cannot resolve HEAD after quarantining worktree at ${wtPath}; recovery state remains locked`
            : `cannot reuse worktree at ${wtPath}: HEAD could not be resolved`,
          o.quarantineForLaunch ? "recovery-preserved" : "reuse-invalid",
        );
      }
      const currentHead = currentHeadProbe.stdout.trim();
      const record: WorktreeRecord = {
        path: wtPath,
        branch: o.branch,
        tachyonCreatedBranch: o.prior?.tachyonCreatedBranch ?? false, // unknown without a prior → assume human-owned (safe: never force-deleted)
        baseRef: o.prior?.baseRef ?? currentHead,
        ...(o.prior?.baseBranch ? { baseBranch: o.prior.baseBranch } : {}), // carry forward (spec 223)
        createdAt: o.prior?.createdAt ?? this.nowIso(),
        // spec 214 — carry the persisted verify result across reuse/restart (review fix: a restart
        // wrote a fresh record and dropped the badge; staleness re-checks HEAD/dirty anyway).
        ...(o.prior?.verify ? { verify: o.prior.verify } : {}),
      };
      return {
        record,
        created: false,
        initialHead: currentHead,
        ...(o.quarantineForLaunch ? { preparationLocked: true } : {}),
      };
    }

    // Create — resolve the branch state, then act.
    const exists = (await this.git(gitArgs.branchExists(o.branch), this.opts.workspaceRoot)).code === 0;
    let state: BranchState = "absent";
    if (exists) state = (await this.branchCheckedOutElsewhere(o.branch)) ? "checked-out-elsewhere" : "exists-free";
    const action = actionForBranchState(o.branch, state);
    if (action.kind === "fail") throw new WorktreeUnavailableError(action.reason, "add-failed");

    const baseRef = (await this.git(gitArgs.headRef(), this.opts.workspaceRoot)).stdout.trim();
    // spec 223 — only when we CREATE a new branch (fork off the main checkout's current branch) is
    // that branch the true PR base; an ATTACHED existing branch wasn't forked from here, so leave its
    // base unknown (codex MAJOR — don't persist a wrong base for attach). "HEAD"/empty = detached.
    const srcBranch = action.kind === "create" ? (await this.git(gitArgs.currentBranch(), this.opts.workspaceRoot)).stdout.trim() : "";
    const baseBranch = srcBranch && srcBranch !== "HEAD" ? srcBranch : undefined;
    const initialHead = action.kind === "create"
      ? baseRef
      : (await this.git(["rev-parse", `refs/heads/${o.branch}`], this.opts.workspaceRoot)).stdout.trim();
    if (!initialHead) throw new WorktreeUnavailableError(`branch '${o.branch}' HEAD could not be resolved`, "add-failed");
    const quarantine = o.quarantineForLaunch === true || o.runSetup !== undefined;
    const addArgs = action.kind === "create"
      ? quarantine ? gitArgs.addNewBranchLocked(wtPath, o.branch, baseRef) : gitArgs.addNewBranch(wtPath, o.branch, baseRef)
      : quarantine ? gitArgs.attachBranchLocked(wtPath, o.branch) : gitArgs.attachBranch(wtPath, o.branch);
    const add = await this.git(addArgs, this.opts.workspaceRoot);
    if (add.code !== 0) throw new WorktreeUnavailableError(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`, "add-failed");

    const record: WorktreeRecord = { path: wtPath, branch: o.branch, tachyonCreatedBranch: action.tachyonCreatedBranch, baseRef, ...(baseBranch ? { baseBranch } : {}), createdAt: this.nowIso() };
    try {
      const initialHeadProbe = await this.git(gitArgs.headRef(), wtPath);
      if (initialHeadProbe.code !== 0 || initialHeadProbe.stdout.trim() !== initialHead) {
        throw new Error("fresh worktree HEAD could not be resolved at its expected branch tip");
      }
      // Fresh checkout (create or attach) → run setup HERE, still holding the lock, so no
      // concurrent reuse-spawn can race into the half-set-up worktree.
      if (o.runSetup) await o.runSetup(record);
      return { record, created: true, initialHead, ...(quarantine ? { preparationLocked: true } : {}) };
    } catch (primary) {
      const preserved = new Error(
        `fresh worktree recovery state was preserved at ${wtPath}; automatic rollback cannot exclude a concurrent write`,
      );
      throw new AggregateError(
        [primary, preserved],
        `fresh worktree preparation failed and its checkout was preserved: ${wtPath}`,
        { cause: primary },
      );
    }
  }

  /**
   * spec 225 — create a FRESH worktree for a forked sibling, branched off the ORIGINAL agent's
   * branch (its committed HEAD): `git worktree add -b <forkBranch> <path> <baseBranch>`. The fork
   * starts from the original's COMMITTED state on its own decoupled branch, so it never touches the
   * original's worktree; uncommitted changes in the original are NOT carried (the caller warns).
   * Always a fresh create (the fork name is unique) — refuses if the path or branch already exists,
   * and throws WorktreeUnavailableError on any git problem so the caller can surface it (fail-closed).
   */
  createFork(forkAgent: string, forkBranch: string, baseBranch: string): Promise<WorktreeRecord> {
    const key = pathFor(resolveBase(this.opts.getSettings()), this.opts.wsHash, forkAgent);
    return this.withLock(key, async () => {
      const usable = await this.isUsableRepo();
      if (!usable.ok) throw new WorktreeUnavailableError(usable.message, usable.reason);
      const fmt = await this.git(gitArgs.checkRefFormat(forkBranch), this.opts.workspaceRoot);
      if (fmt.code !== 0) throw new WorktreeUnavailableError(`invalid branch name '${forkBranch}'`, "add-failed");
      await this.git(gitArgs.prune(), this.opts.workspaceRoot);
      const wtPath = key;
      if (this.exists(wtPath)) throw new WorktreeUnavailableError(`fork worktree path already exists: ${wtPath}`, "add-failed");
      if ((await this.git(gitArgs.branchExists(forkBranch), this.opts.workspaceRoot)).code === 0) {
        throw new WorktreeUnavailableError(`fork branch '${forkBranch}' already exists`, "add-failed");
      }
      // baseRef = the original branch's committed tip (the fork's fork-point, for ahead/behind in status).
      const baseRefProbe = await this.git(["rev-parse", baseBranch], this.opts.workspaceRoot);
      const baseRef = baseRefProbe.code === 0 ? baseRefProbe.stdout.trim() : "";
      const add = await this.git(gitArgs.addNewBranchLocked(wtPath, forkBranch, baseBranch), this.opts.workspaceRoot);
      if (add.code !== 0) throw new WorktreeUnavailableError(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`, "add-failed");
      // baseBranch = the original's branch (what the fork forked from) — the natural PR base (spec 223).
      return { path: wtPath, branch: forkBranch, tachyonCreatedBranch: true, baseRef, baseBranch, createdAt: this.nowIso() };
    });
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
   * Remove the worktree. Soft by default (no --force) so Git refuses a dirty tree.
   * Pass `force: true` only after an explicit data-loss confirm (spec 392).
   * Branch deleted ONLY when Tachyon-created AND deleteBranch is set.
   */
  remove(
    rec: WorktreeRecord,
    deleteBranch: boolean,
    opts?: {
      force?: boolean;
      /**
       * When set, probe dirtiness under this same lock before remove.
       * - clean → soft remove (no --force) unless force is true
       * - dirty/unknown → require force (caller must have confirmDirty)
       */
      refuseUnlessForceIfDirty?: boolean;
    },
  ): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
    return this.withLock(rec.path, async () => {
      if (!this.opts.occupancy) {
        return { removed: false, branchDeleted: false, error: `worktree occupancy unknown for ${rec.path}: no occupancy probe configured` };
      }
      let occ: WorktreeOccupancy | undefined;
      try {
        occ = await this.opts.occupancy(rec.path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { removed: false, branchDeleted: false, error: `worktree occupancy unknown for ${rec.path}: ${msg}` };
      }
      if (occ) {
        return { removed: false, branchDeleted: false, error: `worktree is ${occ.state === "dirty" ? "quarantined by" : "occupied by"} agent '${occ.agent}' (cwd ${occ.cwd})` };
      }
      // Default force=true preserves pre-392 UI/pipeline/GitDelivery callers that already
      // confirmed cleanup. Managed Bridge paths pass force explicitly (soft when clean).
      let force = opts?.force !== false;
      if (opts?.refuseUnlessForceIfDirty && this.exists(rec.path)) {
        const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], rec.path);
        if (status.code !== 0) {
          if (!force) {
            return {
              removed: false,
              branchDeleted: false,
              error: `worktree dirtiness unknown at ${rec.path}; pass confirmDirty=true to force-remove`,
            };
          }
        } else if (status.stdout.trim().length > 0 && !force) {
          return {
            removed: false,
            branchDeleted: false,
            error: `worktree is dirty at ${rec.path}; pass confirmDirty=true to force-remove uncommitted work`,
          };
        }
      }
      // Soft remove when clean (Git re-checks); --force only when explicitly authorized.
      const rm = await this.git(gitArgs.remove(rec.path, force), this.opts.workspaceRoot);
      if (rm.code !== 0) return { removed: false, branchDeleted: false, error: rm.stderr.trim() || rm.stdout.trim() };
      let branchDeleted = false;
      if (deleteBranch && rec.tachyonCreatedBranch) {
        // SAFE delete: git refuses if the branch has commits not merged into HEAD/upstream,
        // so unmerged work is never lost on the normal Remove (review/dogfood fix). A
        // branch with unmerged commits stays — the caller offers a spelled-out force-delete.
        const del = await this.git(gitArgs.deleteBranchSafe(rec.branch), this.opts.workspaceRoot);
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

  /**
   * C2 (spec 213) — the agent's whole contribution since the worktree was born: tracked
   * changes vs `baseRef` (working-tree compare, rename/copy-aware) ∪ untracked files (as
   * adds). Empty on any git failure (stale/removed worktree) — the caller shows a notice.
   */
  async changedFiles(cwd: string, baseRef: string): Promise<ChangedFile[]> {
    try {
      const diff = await this.git(gitArgs.diffNameStatus(baseRef), cwd);
      if (diff.code !== 0) return [];
      const others = await this.git(gitArgs.lsOthers(), cwd);
      return mergeChanges(parseNameStatus(diff.stdout), others.code === 0 ? others.stdout : "");
    } catch {
      return []; // removed worktree (cwd ENOENT) / git absent — nothing to review, no crash
    }
  }

  /**
   * spec 384 — current branch name at `cwd` (agent session / worktree / workspace root).
   * Best-effort: `undefined` on git failure, detached HEAD (`HEAD`), or unborn branch.
   */
  async currentBranch(cwd: string): Promise<string | undefined> {
    try {
      const r = await this.git(gitArgs.currentBranch(), cwd);
      if (r.code !== 0) return undefined;
      const branch = r.stdout.trim();
      if (!branch || branch === "HEAD") return undefined;
      return branch;
    } catch {
      return undefined;
    }
  }

  /**
   * C3 (spec 214) — the worktree's current HEAD sha + a cheap dirty flag, for verify staleness.
   * Best-effort: "" / false on any git failure (removed/absent), which the badge reads as stale.
   */
  async headState(cwd: string): Promise<{ headRef: string; dirty: boolean }> {
    try {
      // ONE subprocess (review fix: was two): porcelain=v2 --branch carries `# branch.oid <sha>`
      // for HEAD and any non-`#` line means a tracked/untracked change → dirty.
      const r = await this.git(["status", "--porcelain=v2", "--branch", "--untracked-files=all"], cwd);
      if (r.code !== 0) return { headRef: "", dirty: false };
      let headRef = "";
      let dirty = false;
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.oid ")) headRef = line.slice("# branch.oid ".length).trim();
        else if (line.length > 0 && !line.startsWith("#")) dirty = true;
      }
      if (headRef === "(initial)") headRef = ""; // unborn HEAD → no verifiable commit
      return { headRef, dirty };
    } catch {
      return { headRef: "", dirty: false };
    }
  }

  /** C2 — a file's content at `ref` (the diff's base side). "" when absent/binary/unreadable. */
  async showFile(cwd: string, ref: string, file: string): Promise<string> {
    try {
      const r = await this.git(gitArgs.showFile(ref, file), cwd);
      return r.code === 0 ? r.stdout : "";
    } catch {
      return "";
    }
  }
}

/** Minimal agent shape the spawn-cwd resolver needs (avoids importing AgentManager → no cycle). */
export interface WorktreeSpawnCtx {
  name: string;
  worktree?: boolean;
  branch?: string;
  worktreeSetup?: string[];
  /** lineage parent — a sub-agent inherits the parent's cwd unless it explicitly opts into worktree isolation */
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
}

/**
 * spec 210 — decide the cwd a session is born in. Returns `null` to mean "use the default
 * cwd" (workspace root / def.cwd), so the AgentManager never has to know about worktrees.
 * Side-effecting via deps (so it unit-tests with git mocked):
 *   - sub-agent (parent set): inherit the parent's cwd unless `worktree:true` opts into its own worktree.
 *   - top-level + worktree:true: ensure() the worktree, run setup once on create, return its path;
 *     ordinary unavailability (no-git / not-repo / unborn / bare / add-fail / reuse-invalid) → notice
 *     + null (fall back to root). Once a quarantine/recovery receipt may exist, errors propagate
 *     fail-closed so an isolated launch never silently moves to the shared root.
 *   - otherwise: null (default).
 */
export async function resolveWorktreeCwd(
  ctx: WorktreeSpawnCtx,
  deps: WorktreeResolveDeps,
): Promise<{ cwd: string; worktree?: WorktreeRecord; created?: boolean; preparationLocked?: boolean; rollbackHeadSha?: string } | null> {
  if (ctx.parent && !ctx.worktree) {
    const inherited = deps.parentCwd(ctx.parent);
    return inherited ? { cwd: inherited } : null; // null → AgentManager uses the root
  }
  if (!ctx.worktree) return null;

  let branch: string;
  try {
    branch = branchFor(ctx.name, deps.settings, { branch: ctx.branch });
  } catch (err) {
    const recoveryPath = deps.priorRecord?.path ?? deps.manager.pathForAgent(ctx.name);
    const primary = err instanceof Error ? err : new Error(String(err));
    throw new WorktreeUnavailableError(
      `cannot resolve isolated branch for '${ctx.name}'; recovery checkout: ${recoveryPath}: ${primary.message}`,
      deps.priorRecord || fs.existsSync(recoveryPath) ? "recovery-preserved" : "add-failed",
    );
  }
  // Setup runs ONCE, only on a fresh create (not restart) — handed to ensure() so it runs
  // under the per-agent lock (review fix: setup must not race a concurrent reuse-spawn).
  const wantSetup = !ctx.isRestart && !!ctx.worktreeSetup && ctx.worktreeSetup.length > 0;
  try {
    const { record: rec, created, initialHead, preparationLocked } = await deps.manager.ensure({
      agent: ctx.name,
      branch,
      prior: deps.priorRecord,
      // Every process launch, including restart, gets a durable quarantine receipt. If a restart
      // has to recreate a missing checkout, this also ensures its fresh `worktree add` is finalized.
      quarantineForLaunch: true,
      runSetup: wantSetup ? (r) => deps.runSetup(r, ctx.worktreeSetup as string[]) : undefined,
    });
    return {
      cwd: rec.path,
      worktree: rec,
      created,
      ...(preparationLocked ? { preparationLocked: true } : {}),
      ...(initialHead ? { rollbackHeadSha: initialHead } : {}),
    };
  } catch (err) {
    // Once `git worktree add` succeeded, a preparation failure preserves a recovery checkout. Never
    // silently turn the requested isolated launch into a root launch or hide that preserved state.
    if (err instanceof AggregateError
      || (err instanceof WorktreeUnavailableError
        && (err.reason === "preparation-failed" || err.reason === "recovery-preserved"))) {
      throw err;
    }
    if (err instanceof WorktreeUnavailableError) {
      deps.notify(`'${ctx.name}' falling back to the workspace root — ${err.message}`, "warn");
      return null;
    }
    // A rejected Git probe can occur after worktree creation or quarantine. Its side effects are
    // unknowable, so an opt-in isolated launch must never turn that raw error into a root launch.
    const recoveryPath = deps.priorRecord?.path ?? deps.manager.pathForAgent(ctx.name);
    const primary = err instanceof Error ? err : new Error(String(err));
    throw new WorktreeUnavailableError(
      `isolated worktree inspection failed for '${ctx.name}'; recovery checkout: ${recoveryPath}: ${primary.message}`,
      "recovery-preserved",
    );
  }
}
