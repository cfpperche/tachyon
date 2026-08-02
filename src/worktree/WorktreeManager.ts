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
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEntry, TachyonConfig } from "../config/loadConfig.js";
import { parseNameStatus, mergeChanges, type ChangedFile } from "./review.js";
import type { VerifyState } from "./verify.js";
import type { WorktreeEvidence } from "./evidence.js";
import type { SharedDependencyState } from "./dependencySharing.js";
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
  /**
   * t-3f93b4 — whether this checkout's `node_modules` is shared with the primary, and the lockfile
   * digest that made sharing legitimate. Persisted for the same reason `verify` is: the value is a
   * claim about a commit-shaped state, so it has to travel with the record that outlives the launch
   * in order for a later divergence to be a COMPARISON rather than a guess.
   */
  dependencies?: SharedDependencyState;
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
export function branchFor(agent: string, settings: TachyonConfig["settings"], agentDef: Pick<AgentEntry, "branch">): string {
  if (agentDef.branch) return agentDef.branch;
  const template = settings.worktree?.branch;
  if (template) {
    if (!template.includes("{agent}")) throw new Error(`worktree branch template '${template}' is missing the {agent} placeholder`);
    return template.replaceAll("{agent}", agent);
  }
  return `tachyon/${agent}`;
}

/**
 * spec 484 — the branch identity of a TEMPORARY child, minted per spawn instead of derived from its
 * name.
 *
 * A declared agent's branch IS its identity: `tachyon/{agent}` is stable across restarts on purpose,
 * and `actionForBranchState` maps `exists-free` → ATTACH so reattaching to it is the whole point. A
 * Temporary name is not an identity — it is reusable across spawns. Under the name-derived template
 * a second child called `codex-residuo` resolves to the FIRST one's branch, finds it free, attaches,
 * and starts building on a stranger's commits while its briefing says it starts from main. That is
 * "unknown flattened into known" (`t-b4a799`) wearing a plausible value, and no warning undoes the
 * commits the child would then build on.
 *
 * A per-spawn branch does not guard the adoption path — it makes the state that reaches it always
 * `absent`, so adoption is UNREACHABLE for a Temporary rather than watched.
 *
 * The shape, and why:
 *   `tachyon/tmp.{agent}.{YYYYMMDD}-{HHMMSS}-{entropy}`
 *
 *   - It carries the agent name, so an orphan branch in `git branch` says whose it was. That is the
 *     hard requirement: a unique-but-opaque id would trade one silent failure for an unreadable one.
 *   - The second path component contains `.`, which `AGENT_NAME_PATTERN` (`^[a-zA-Z][a-zA-Z0-9_-]*$`)
 *     forbids. So `tachyon/tmp.…` can never equal `tachyon/{agent}` for ANY valid agent name — the
 *     disjointness from the declared namespace is structural, not a convention someone must keep.
 *     Staying flat under `tachyon/` also means no directory/file ref conflict with `tachyon/{agent}`,
 *     which a nested `tachyon/tmp/{agent}/…` would create for an agent actually named `tmp`.
 *   - The UTC stamp sorts spawns chronologically in `git branch` output, which is what a human
 *     sweeping leftovers needs to tell the first child from the fifth; the entropy covers two spawns
 *     of one name inside the same second.
 *   - `tachyon/tmp.*` is a single glob for finding every ephemeral leftover.
 *
 * Pure, with the clock and the entropy injectable, so the shape unit-tests without either.
 */
export function temporaryBranchFor(
  agent: string,
  now: Date = new Date(),
  entropy: string = randomBytes(2).toString("hex"),
): string {
  const stamp = now.toISOString().replaceAll(/[-:]/gu, "").replace(/\..*$/u, "").replace("T", "-");
  return `tachyon/tmp.${agent}.${stamp}-${entropy}`;
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
/**
 * t-05dff5 — MEASURED proof that the checkout a record points at is not a working tree of this
 * repository (as opposed to a removal that failed for a real reason: lock, permission, dirtiness).
 *
 * - `missing`: nothing at that path on disk, and git does not list it as a worktree.
 * - `not-a-worktree`: something is still on disk there, but git does not own it — `git worktree
 *   remove` can never succeed on it, and deleting a directory git disclaims is not our business.
 */
export type WorktreeAbsence = "missing" | "not-a-worktree";

export interface WorktreeRemovalResult {
  removed: boolean;
  branchDeleted: boolean;
  error?: string;
  /**
   * Set only when the failure was PROVED to be "there was nothing here to remove". Callers that
   * own a durable claim on this checkout may treat it as done; everyone else keeps failing.
   */
  absent?: WorktreeAbsence;
}

export type WorktreeOccupancy = { state: "live" | "pending" | "dirty"; agent: string; cwd: string };
export type WorktreeOccupancyProbe = (worktreePath: string) => Promise<WorktreeOccupancy | undefined>;

export function createGitExec(resolveBinary: () => string): GitExec {
  return (args, cwd) => new Promise((resolve, reject) => {
    execFile(resolveBinary(), args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        // t-05dff5 — spawn ENOENT has TWO causes and they are not the same fact: git is not
        // installed, or the cwd we asked git to run in no longer exists. Blaming the binary for a
        // deleted checkout turned "this worktree is gone" into "git not found on PATH", and every
        // best-effort probe that ran inside a removed worktree threw instead of reporting. Measure
        // which one it is, and report a missing cwd the way git itself reports it: a fatal (128),
        // so `status()`'s documented best-effort contract holds instead of exploding.
        if (!fs.existsSync(cwd)) {
          return resolve({ stdout: "", stderr: `fatal: cannot change to '${cwd}': No such file or directory`, code: 128 });
        }
        return reject(gitNotFoundError());
      }
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
  /**
   * spec 444 — true when the `rev-list baseRef..HEAD` probe itself failed (unresolvable/deleted
   * baseRef, corrupt repo), in which case `aheadOfBase` is a best-effort 0 that MUST NOT be read
   * as "contained in base". The kill/dismiss confirmation UI ignores this; classify.ts fails
   * closed on it (a silent 0 here once classified a worktree of unknown ancestry ready-to-remove).
   */
  aheadProbeFailed?: boolean;
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
   * AgentManager releases it only after ownership and canonical Delivery authority are durable. */
  quarantineForLaunch?: boolean;
  /**
   * Run worktreeSetup in the freshly-created checkout — invoked by ensure() UNDER the
   * per-agent lock, only when it created the worktree, so a concurrent spawn can't reuse
   * the path and start before setup finishes (review fix). Omit on restart/reuse.
   */
  runSetup?: (rec: WorktreeRecord) => Promise<void>;
  /**
   * t-3f93b4 — reconcile `<worktree>/node_modules` against the primary checkout, and hand back what
   * is now true. Runs on BOTH the create and the reuse paths, under the same lock, because create
   * and restart/resume/relaunch are one mechanism reached through different doors — a check wired
   * only into create would link a matching lockfile once and then never notice the rebase that broke
   * it. Also runs BEFORE `runSetup`, so a `worktreeSetup` that builds can see the dependencies.
   */
  shareDependencies?: (worktreePath: string) => SharedDependencyState | undefined;
}

/**
 * Owns the side-effecting git mechanics. Pure decisions are the module functions above;
 * this serializes per-agent (a lock chain) so concurrent spawn/restart/remove never race
 * the same worktree, and translates every git failure into a typed fallback signal so the
 * caller can fall back to the workspace root instead of blocking the agent.
 */
export class WorktreeManager {
  private locks = new Map<string, Promise<unknown>>();
  /** t-3fb6eb: path keys held by the current async context — reentrant for nested same-path ops (prune→remove). */
  private readonly heldPathLocks = new AsyncLocalStorage<ReadonlySet<string>>();

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
    const held = this.heldPathLocks.getStore();
    if (held?.has(key)) {
      // Already owning this path in the current async context — reenter without queueing.
      return fn();
    }
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => {
        const nextHeld = new Set(held ?? []);
        nextHeld.add(key);
        return this.heldPathLocks.run(nextHeld, fn);
      },
      () => {
        const nextHeld = new Set(held ?? []);
        nextHeld.add(key);
        return this.heldPathLocks.run(nextHeld, fn);
      },
    );
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
   * ownership (and, for a gate, its canonical Delivery). Until this point Git's worktree lock is a
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
      // t-2dd637 — a prior-less reuse (respawn onto a worktree whose failed first launch never
      // persisted a ledger row) must carry base identity the way a clean spawn does. Dropping
      // baseBranch here degrades the projection base from a symbolic ref to a pinned SHA, which
      // makes `containedInBase` monotonically unsatisfiable. Re-derive it from the workspace root
      // with the same probe the create path uses (:624). Fail-closed: a failed probe or a detached
      // HEAD leaves it absent so the gated open refuses rather than pinning a SHA.
      let baseBranch = o.prior?.baseBranch;
      if (!baseBranch) {
        const srcProbe = await this.git(gitArgs.currentBranch(), this.opts.workspaceRoot);
        const srcBranch = srcProbe.code === 0 ? srcProbe.stdout.trim() : "";
        baseBranch = srcBranch && srcBranch !== "HEAD" ? srcBranch : undefined;
      }
      // t-3f93b4 — RE-decide, never carry forward. `prior.dependencies` records what was true at the
      // last launch; a branch that rebased onto a base with a different lockfile since then would
      // otherwise relaunch still claiming a link that is now wrong. Recomputing is two file reads.
      const dependencies = o.shareDependencies?.(wtPath);
      const record: WorktreeRecord = {
        path: wtPath,
        branch: o.branch,
        tachyonCreatedBranch: o.prior?.tachyonCreatedBranch ?? false, // unknown without a prior → assume human-owned (safe: never force-deleted)
        baseRef: o.prior?.baseRef ?? currentHead,
        ...(baseBranch ? { baseBranch } : {}), // carry forward (spec 223), else re-derived above (t-2dd637)
        createdAt: o.prior?.createdAt ?? this.nowIso(),
        // spec 214 — carry the persisted verify result across reuse/restart (review fix: a restart
        // wrote a fresh record and dropped the badge; staleness re-checks HEAD/dirty anyway).
        ...(o.prior?.verify ? { verify: o.prior.verify } : {}),
        ...(dependencies ? { dependencies } : {}),
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
      // t-3f93b4 — the checkout exists and is at its expected tip, so its lockfile is now readable.
      // Decide dependency sharing BEFORE setup, so a `worktreeSetup` that builds or tests is not the
      // thing that discovers the worktree has nothing installed.
      const dependencies = o.shareDependencies?.(wtPath);
      if (dependencies) record.dependencies = dependencies;
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
    const aheadProbeFailed = ahead.code !== 0;
    const aheadOfBase = aheadProbeFailed ? 0 : Number.parseInt(ahead.stdout.trim() || "0", 10) || 0;
    const up = await this.git(["rev-list", "--count", "@{upstream}..HEAD"], cwd);
    const hasUpstream = up.code === 0;
    const unpushed = hasUpstream ? Number.parseInt(up.stdout.trim() || "0", 10) || 0 : aheadOfBase;
    return { staged, unstaged, untracked, conflicts, detached, branch: detached ? null : branchName, aheadOfBase, ...(aheadProbeFailed ? { aheadProbeFailed } : {}), unpushed, hasUpstream };
  }

  /**
   * Remove the worktree via `git worktree remove`.
   *
   * **Force default (legacy/internal):** when `opts` is omitted or `force` is not
   * set to `false`, removal uses `--force` so dirty trees are deleted. This preserves
   * pre-392 UI/pipeline callers that already confirmed cleanup at a higher layer.
   *
   * **Safety-sensitive callers** (managed Bridge façade, soft remove paths) MUST pass
   * an explicit `force: false` (or `force: true` only after confirmDirty). Prefer also
   * setting `refuseUnlessForceIfDirty` so dirtiness is probed under the same lock.
   *
   * Occupancy is always fail-closed before force is considered (spec 392): occupied or
   * unknown occupancy never removes, even with `force: true`.
   *
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
  ): Promise<WorktreeRemovalResult> {
    return this.withLock(rec.path, async () => {
      // t-dcdb7f — occupancy refusals name a reachable exit (or that only a human can wire the seam).
      // Occupancy cannot be forced past; confirmDirty only covers dirtiness, never a live cwd.
      if (!this.opts.occupancy) {
        return {
          removed: false,
          branchDeleted: false,
          error:
            `worktree occupancy unknown for ${rec.path}: no occupancy probe configured` +
            " — requires host wiring (human); cannot force past occupancy",
        };
      }
      let occ: WorktreeOccupancy | undefined;
      try {
        occ = await this.opts.occupancy(rec.path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          removed: false,
          branchDeleted: false,
          error:
            `worktree occupancy unknown for ${rec.path}: ${msg}` +
            "; retry once occupancy is measurable — cannot force past occupancy",
        };
      }
      if (occ) {
        const relation = occ.state === "dirty" ? "quarantined by" : "occupied by";
        return {
          removed: false,
          branchDeleted: false,
          error:
            `worktree is ${relation} agent '${occ.agent}' (cwd ${occ.cwd})` +
            `; stop agent '${occ.agent}' (kill_agent) or wait until it leaves this worktree`,
        };
      }
      // Legacy default force=true (opts omitted). Managed Bridge passes force explicitly.
      let force = opts?.force !== false;
      if (opts?.refuseUnlessForceIfDirty && this.exists(rec.path)) {
        const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], rec.path);
        if (status.code !== 0) {
          if (!force) {
            // Preserve t-05dff5's idempotent door: a path already disclaimed by both Git and disk
            // has no dirty checkout to protect. Prove that state before treating a failed status
            // probe as unknown dirtiness; permission/lock failures still refuse below.
            const absent = await this.probeAbsence(rec.path);
            if (absent) {
              return {
                removed: false,
                branchDeleted: false,
                error: status.stderr.trim() || status.stdout.trim(),
                absent,
              };
            }
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
      if (rm.code !== 0) {
        const error = rm.stderr.trim() || rm.stdout.trim();
        // t-05dff5 — a failed `git worktree remove` is not automatically a failure to remove. When
        // the checkout is already gone (another door removed it, or a human deleted it), git says
        // `is not a working tree` and there is nothing left to do. That is not inferred from the
        // message: `probeAbsence` re-measures the repository and the disk, so a lock, a permission
        // error or a dirty refusal still fails exactly as before.
        const absent = await this.probeAbsence(rec.path);
        if (!absent) return { removed: false, branchDeleted: false, error };
        await this.git(gitArgs.prune(), this.opts.workspaceRoot);
        return { removed: false, branchDeleted: false, error, absent };
      }
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
   * t-05dff5 — is this path still a working tree of this repository? Answers only from what it can
   * measure: `git worktree list` (the repository's own view) and the disk. A list probe that itself
   * failed proves nothing, so it answers `undefined` — fail-closed, the caller keeps its error.
   *
   * A path git still lists (including a `prunable` one whose directory a human deleted) is NOT
   * absent: git can still act on it, and `git worktree remove` on it succeeds. Only a path git
   * disclaims entirely gets an absence verdict.
   */
  private async probeAbsence(worktreePath: string): Promise<WorktreeAbsence | undefined> {
    const listed = await this.git(gitArgs.listWorktrees(), this.opts.workspaceRoot);
    if (listed.code !== 0) return undefined;
    const abs = path.resolve(worktreePath);
    const known = listed.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .some((line) => path.resolve(line.slice("worktree ".length).trim()) === abs);
    if (known) return undefined;
    return this.exists(abs) ? "not-a-worktree" : "missing";
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
  /**
   * spec 484 — Temporary (MCP-spawned) rather than declared in `tachyon.yml`.
   *
   * The one fact that decides whether the agent's NAME may stand for its branch identity. A declared
   * name is unique and durable by construction (the roster owns it); a Temporary name is neither, so
   * the two must not share the name-derived template. `SpawnCwdContext.temporary` has carried this
   * since spec 210 — it simply never reached the resolver that needed it.
   */
  temporary?: boolean;
  /** restart/resume — reuse the worktree, never re-run setup */
  isRestart: boolean;
  /**
   * t-da80ed — the `workspace.cwd` the profile declares, ALREADY resolved to an absolute path.
   *
   * This resolver decides where an agent is born, and every directory it hands back overrides the
   * declared one. Until this field existed it could not even see what the human asked for, so the
   * override was not a conflict resolved in the worktree's favour — it was a value that never
   * arrived. The precedence is unchanged (isolation wins, as it always has); what changes is that a
   * discarded declaration is now said out loud, the way this file already speaks about every other
   * directory it substitutes.
   */
  declaredCwd?: string;
}

export interface WorktreeResolveDeps {
  manager: WorktreeManager;
  settings: TachyonConfig["settings"];
  /**
   * t-c9da28 — where the parent runs, AND whether it is a known agent at all.
   *
   * The two facts travel together because their absences mean opposite things and used to collapse
   * into one `undefined`: a parent nobody has heard of is a caller mistake, while a known parent with
   * no recorded directory is a gap in OUR records that the child can survive. With only "no cwd" to
   * go on, this function had to guess which — and it guessed the silent one.
   *
   * Async so the caller may consult a live authority instead of one cached row. It is awaited only on
   * the path that already lacks a recorded cwd, so an ordinary inheriting spawn pays nothing.
   */
  resolveParent: (parent: string) => Promise<{ cwd?: string; known: boolean }>;
  /** the prior persisted worktree record for this agent (validated reuse) */
  priorRecord?: WorktreeRecord;
  /** run worktreeSetup in the fresh worktree (sequential/stop-on-failure/non-fatal) — only on create */
  runSetup: (rec: WorktreeRecord, setup: string[]) => Promise<void>;
  /**
   * t-3f93b4 — reconcile the worktree's `node_modules` against the primary checkout's. Injected the
   * way `runSetup` is, because it needs the workspace root and a filesystem this module has no
   * business reaching for itself. Omitted → no sharing at all (what every caller did before t-3f93b4).
   */
  shareDependencies?: (worktreePath: string) => SharedDependencyState | undefined;
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
/**
 * t-da80ed — say it when the directory an agent is born in is NOT the one its profile declares.
 *
 * The Studio refuses the contradiction at write time, so this speaks for the profile edited by hand
 * and for the pair a profile carried in from before that refusal existed. It stays a notice rather
 * than a throw on purpose: refusing here would turn such a profile into one that cannot launch,
 * bricking the very agent the fix is meant to protect.
 *
 * Silent when the declaration agrees with where the agent actually lands — there is nothing to warn
 * about when the human got what they asked for.
 */
function announceDiscardedCwd(
  ctx: WorktreeSpawnCtx,
  deps: WorktreeResolveDeps,
  effective: string,
  because: string,
): void {
  if (!ctx.declaredCwd) return;
  if (path.resolve(ctx.declaredCwd) === path.resolve(effective)) return;
  deps.notify(
    `'${ctx.name}' declares workspace.cwd ${ctx.declaredCwd}, but ${because} — running in ${effective} instead`,
    "warn",
  );
}

/**
 * spec 484 — what to hand `branchFor` through its `agentDef.branch` seam, which it honours ahead of
 * the template. No new machinery: the seam already exists and this is its one new caller.
 *
 * The precedence, and the reason for each rung:
 *
 *   1. An EXPLICIT `ctx.branch` wins for anyone. The caller named a ref; that is an identity it owns
 *      and this function has no standing to overrule it.
 *   2. A DECLARED agent gets `undefined` — the template/`tachyon/{agent}` path, byte for byte what it
 *      resolved to before this change. Its branch is its identity and reattaching to it is correct.
 *   3. A Temporary WITH a prior record keeps that record's branch. This is not the defect: the prior
 *      record is this agent's OWN persisted row, so it means restart, resume, or a relaunch of a
 *      still-rostered child — the same child, not a namesake. Minting a fresh branch here would also
 *      brick it, because `ensure()` reuses `prior.path` and `validateReuse` would then reject the
 *      checkout for being on the "wrong" branch.
 *   4. A Temporary with NO prior record is a genuinely new child, and gets a fresh identity. The
 *      dismissed-then-respawned case lands here: dismiss clears the ledger row, so a leftover
 *      `tachyon/{name}` branch is no longer reachable by name and cannot be adopted. A leftover
 *      CHECKOUT at the name-derived path still fails closed through `validateReuse` → the existing
 *      `recovery-preserved` propagation — loudly, never as a silent landing in a stranger's tree.
 */
function spawnBranchIdentity(ctx: WorktreeSpawnCtx, prior?: WorktreeRecord): string | undefined {
  if (ctx.branch) return ctx.branch;
  if (!ctx.temporary) return undefined;
  if (prior?.branch) return prior.branch;
  return temporaryBranchFor(ctx.name);
}

export async function resolveWorktreeCwd(
  ctx: WorktreeSpawnCtx,
  deps: WorktreeResolveDeps,
): Promise<{ cwd: string; worktree?: WorktreeRecord; created?: boolean; preparationLocked?: boolean; rollbackHeadSha?: string } | null> {
  if (ctx.parent && !ctx.worktree) {
    const parent = await deps.resolveParent(ctx.parent);
    if (parent.cwd) {
      announceDiscardedCwd(ctx, deps, parent.cwd, `a sub-agent runs where its parent '${ctx.parent}' runs`);
      return { cwd: parent.cwd };
    }
    // t-c9da28 — the two ways a parent can have no cwd are not the same failure.
    //
    // `spawn_agent` already refuses an explicit `cwd` for a parented child precisely so the caller is
    // never misled about where it runs. One step earlier, this used to substitute a directory the
    // caller never asked for — the workspace ROOT, which is the one place an isolated child least
    // belongs — and say nothing at all.
    //
    // An unknown parent is a caller mistake and cannot be repaired by guessing: whatever we picked
    // would be someone else's checkout. Refuse, and name it.
    if (!parent.known) {
      throw new Error(
        `agent '${ctx.name}' cannot inherit from parent '${ctx.parent}': no such agent is known to this workspace`,
      );
    }
    // A KNOWN parent whose directory we cannot recover is our gap, not the caller's, and the child
    // still has somewhere to run. Falling back stays — a coordinator that restarted must still be
    // able to spawn — but it stops being silent, in the same shape this file already uses for
    // worktree unavailability.
    deps.notify(
      `'${ctx.name}' falling back to the workspace root — parent '${ctx.parent}' has no recorded working directory`,
      "warn",
    );
    return null; // null → AgentManager uses the root
  }
  if (!ctx.worktree) return null;

  let branch: string;
  try {
    branch = branchFor(ctx.name, deps.settings, { branch: spawnBranchIdentity(ctx, deps.priorRecord) });
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
  // t-3f93b4 — unlike setup, this runs on EVERY launch including restart: setup is a one-time build
  // step, while dependency sharing is a claim about the lockfile that has to be re-checked each time
  // the branch could have moved. Default ON; `settings.worktree.shareDependencies: false` opts a
  // workspace out for which sharing one directory across checkouts is genuinely wrong.
  const wantShare = deps.settings.worktree?.shareDependencies !== false && deps.shareDependencies;
  try {
    const { record: rec, created, initialHead, preparationLocked } = await deps.manager.ensure({
      agent: ctx.name,
      branch,
      prior: deps.priorRecord,
      // Every process launch, including restart, gets a durable quarantine receipt. If a restart
      // has to recreate a missing checkout, this also ensures its fresh `worktree add` is finalized.
      quarantineForLaunch: true,
      runSetup: wantSetup ? (r) => deps.runSetup(r, ctx.worktreeSetup as string[]) : undefined,
      ...(wantShare ? { shareDependencies: deps.shareDependencies } : {}),
    });
    announceDiscardedCwd(ctx, deps, rec.path, "it runs in its own git worktree, which IS its working directory");
    // t-3f93b4 — divergence is never a silent downgrade. `absent` after a lockfile mismatch means the
    // agent is about to be handed a checkout its primer tells it to verify in and it cannot; the
    // human hears it here, and the agent hears the same fact in its primer.
    if (rec.dependencies?.mode === "absent") {
      deps.notify(`'${ctx.name}' has no shared node_modules — ${rec.dependencies.reason}`, "warn");
    }
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
      // spec 484 — the fallback's discriminator was "might we have created recoverable state?" (the
      // branch just above). That is the wrong question for an ordinary unavailability: nothing was
      // created, so nothing needs preserving, and the answer turns on WHO asked and what the root
      // means to them.
      //
      // For a top-level agent the workspace root is its home; landing there is a degraded launch, not
      // a wrong one, and refusing would brick an agent over a git condition it can work without. That
      // path is unchanged, notice and all.
      //
      // A PARENTED child is the opposite case. It did not merely tolerate isolation — it opted in,
      // and without a worktree the root is the HUMAN'S primary checkout: strictly worse than doing
      // nothing, since inheriting the parent's tree (what it would have got without the flag) at
      // least keeps it inside an agent's own directory. So the one request the fallback can satisfy
      // is the one it must not: it would put a delegated child in the one place nobody asked it to
      // write. Fail closed, and say which unavailability caused it.
      if (ctx.parent) {
        throw new WorktreeUnavailableError(
          `'${ctx.name}' asked for an isolated worktree under parent '${ctx.parent}' and cannot have one — ${err.message}`,
          err.reason,
        );
      }
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
