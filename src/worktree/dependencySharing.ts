/**
 * t-3f93b4 / t-5ac1df — materialize project-declared worktree-local resources.
 *
 * The contradiction this module closes: Tachyon hands an agent a checkout where project tooling may
 * not run and used to say nothing about that dependency state. Measured on 2026-08-02 with three delegated children
 * live: each worktree carried its OWN 478 MB `node_modules` (a real directory, not a link), because
 * each agent independently discovered the gap and ran `npm ci` to close it. Three children, 1.4 GB,
 * and minutes of wall clock apiece before any of them could verify anything. Every agent solving the
 * same problem its own way is the definition of a missing contract.
 *
 * All worktrees of one workspace are checkouts of the SAME clone at the same base commit, so the
 * primary checkout's dependency directory is usually the exact directory the child needs. Linking to
 * it is instant and costs zero bytes.
 *
 * WHY THIS IS NOT JUST "ALWAYS SYMLINK". A shared `node_modules` is correct only while the child's
 * lockfile is the primary's lockfile. A child that EDITS dependencies, or rebases onto a base that
 * edited them, would then run against the wrong packages — silently, which is the worst shape. That
 * is precisely the defect family catalogued in `t-b4a799`: a plausible value standing where "I don't
 * know" belongs. So the decision this module makes is never "link or install"; it is:
 *
 *   1. link ONLY when the two checkouts' lockfiles are byte-identical, and
 *   2. record the digest that made the link legitimate, so divergence is a comparison and not a guess,
 *   3. and when they diverge, REMOVE the link and say so — an absent `node_modules` fails loudly at
 *      the first import, which is strictly better than a green check computed from wrong packages.
 *
 * Divergence detection is a SHA-256 over lockfile bytes. Deliberately not mtime: `git checkout`,
 * `git worktree add` and `npm ci` all rewrite timestamps on unchanged content, so mtime answers a
 * different question than the one being asked and would both false-alarm and false-reassure.
 *
 * `absent` from a lockfile is NOT the same as `absent` from the other side: a child that ADDS a
 * `pnpm-lock.yaml` the primary does not have has diverged, so the digest covers the file NAMES as
 * well as their contents.
 *
 * Node lockfile divergence remains a deliberately narrow safety case. Other ecosystems may share
 * any declared, gitignored directory, but Tachyon makes no claim that it can detect when that
 * ecosystem's dependency inputs diverge. Adding a speculative package-manager table here would be
 * policy without evidence.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The one declared directory for which Tachyon knows how to detect divergence. Every recognized
 * lockfile is listed because any one appearing on only one side changes what populates node_modules.
 */
export const DEPENDENCY_DIR = "node_modules";
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
] as const;

/** What a checkout's `node_modules` currently is. `foreign` = a real directory (or a link we did not make). */
export type DependencyDirState = "absent" | "shared-link" | "foreign";

/**
 * Persisted on the WorktreeRecord: the decision and the digest that justified it.
 *
 * Three modes because "not linked" is two different facts and collapsing them would put a plausible
 * value where a distinction belongs: `absent` means the agent has to install before anything runs,
 * `own` means it already has dependencies and must NOT be told to install.
 */
export interface SharedDependencyState {
  /** `linked` = `<worktree>/node_modules` is a Tachyon symlink to the primary's; `absent` = nothing is there; `own` = a real directory this checkout owns. */
  mode: "linked" | "absent" | "own";
  /** sha256 over the lockfile set that the decision was made against — the value divergence is measured from. */
  lockDigest: string;
  /** the primary checkout's dependency directory, only when linked. */
  target?: string;
  /** one human sentence, ALWAYS present — including for `linked`, so the reason is legible either way. */
  reason: string;
  /** ISO timestamp of the decision. */
  at: string;
}

/** Digest over the lockfile SET: names and bytes both, so an added or removed lockfile is divergence. */
export interface LockfileFingerprint {
  digest: string;
  /** lockfile names that were present, sorted — for the human-readable reason. */
  files: string[];
}

/** `read` returns the file's bytes, or null when it is absent/unreadable. Pure given that reader. */
export function fingerprintLockfiles(read: (name: string) => Buffer | null): LockfileFingerprint {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const name of LOCKFILES) {
    const bytes = read(name);
    if (!bytes) continue;
    files.push(name);
    // Length-prefixed so no pair of (name, content) concatenations can collide.
    hash.update(`${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  // An empty set still digests to a stable value; `files: []` is what tells the caller it is empty.
  return { digest: hash.digest("hex"), files };
}

export type DependencySharingPlan =
  /** create (or keep) the symlink — the two lockfile sets are byte-identical. */
  | { kind: "link"; digest: string; reason: string }
  /** remove OUR stale link if present; this checkout must build its own dependencies. */
  | { kind: "unshare"; digest: string; reason: string }
  /** touch nothing — either there is nothing to share, or the checkout already owns a real directory. */
  | { kind: "leave"; digest: string; reason: string };

export interface DependencySharingInput {
  primary: LockfileFingerprint;
  worktree: LockfileFingerprint;
  /** the primary checkout has a usable `node_modules` to point at. */
  primaryHasDependencies: boolean;
  /** what the worktree's `node_modules` is right now. */
  worktreeDir: DependencyDirState;
}

/**
 * The whole decision, pure.
 *
 * Order matters and each rung is a refusal to guess:
 *
 *  - A FOREIGN `node_modules` is never touched. The agent (or a `worktreeSetup`) installed it, it may
 *    hold work, and replacing a real directory with a link to someone else's is exactly the silent
 *    substitution this module exists to prevent.
 *  - No lockfile on EITHER side means this is not a lockfile-managed Node project; there is no fact
 *    that could make sharing safe, so nothing is shared and nothing is claimed.
 *  - Divergent digests unshare rather than link. If a stale link is already there it goes, loudly:
 *    `Cannot find module` at the first import beats a passing suite computed from wrong packages.
 *  - A matching digest with no primary directory to point at is still `unshare` — there is nothing to
 *    link TO, and pretending otherwise would leave a dangling symlink that reads as "dependencies are
 *    present" to every tool that only checks existence.
 */
export function planDependencySharing(input: DependencySharingInput): DependencySharingPlan {
  const digest = input.worktree.digest;
  if (input.worktreeDir === "foreign") {
    return { kind: "leave", digest, reason: `${DEPENDENCY_DIR} already exists in this worktree and was not created by Tachyon` };
  }
  if (input.primary.files.length === 0 && input.worktree.files.length === 0) {
    return { kind: "leave", digest, reason: "no lockfile in either checkout, so there is no dependency set to share" };
  }
  if (input.primary.digest !== input.worktree.digest) {
    return { kind: "unshare", digest, reason: lockfileDivergenceReason(input.primary, input.worktree) };
  }
  if (!input.primaryHasDependencies) {
    return { kind: "unshare", digest, reason: `the lockfiles match but the primary checkout has no ${DEPENDENCY_DIR} to share` };
  }
  return {
    kind: "link",
    digest,
    reason: `lockfiles are identical to the primary checkout (${input.worktree.files.join(", ")} @ ${digest.slice(0, 12)})`,
  };
}

/** Name WHICH lockfiles disagree — "they differ" without saying how is the kind of message nobody acts on. */
function lockfileDivergenceReason(primary: LockfileFingerprint, worktree: LockfileFingerprint): string {
  const added = worktree.files.filter((f) => !primary.files.includes(f));
  const removed = primary.files.filter((f) => !worktree.files.includes(f));
  const parts: string[] = [];
  if (added.length > 0) parts.push(`this worktree adds ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`this worktree is missing ${removed.join(", ")}`);
  if (parts.length === 0) {
    const shared = worktree.files.length > 0 ? worktree.files.join(", ") : "the lockfile set";
    parts.push(`${shared} differs in content from the primary checkout`);
  }
  return `${parts.join("; ")} — this worktree needs its own dependencies`;
}

/** The filesystem surface, injected so the applier tests without a real disk. */
export interface DependencyFsLike {
  readFile: (p: string) => Buffer;
  /** `lstat` semantics: it must NOT follow a symlink, because "is this our link?" is the question. */
  lstat: (p: string) => { isSymbolicLink: () => boolean; isDirectory: () => boolean };
  /** `stat` semantics: it MUST follow, so a primary whose own `node_modules` is a link still counts. */
  stat: (p: string) => { isDirectory: () => boolean };
  readlink: (p: string) => string;
  symlink: (target: string, p: string) => void;
  unlink: (p: string) => void;
}

const nodeFs: DependencyFsLike = {
  readFile: (p) => fs.readFileSync(p),
  lstat: (p) => fs.lstatSync(p),
  stat: (p) => fs.statSync(p),
  readlink: (p) => fs.readlinkSync(p),
  symlink: (target, p) => fs.symlinkSync(target, p, "dir"),
  unlink: (p) => fs.unlinkSync(p),
};

function readLockfiles(dir: string, io: DependencyFsLike): (name: string) => Buffer | null {
  return (name) => {
    try {
      return io.readFile(path.join(dir, name));
    } catch {
      return null;
    }
  };
}

type Warn = (message: string) => void;

function literalPath(raw: string, source: string, warn: Warn): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized.startsWith("!") || /[*?\[]/.test(normalized)) {
    warn(`${source}: skipping unsupported pattern '${raw}' (only literal paths are supported)`);
    return undefined;
  }
  if (!normalized || path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    warn(`${source}: skipping unsafe path '${raw}'`);
    return undefined;
  }
  const segments = normalized.split("/");
  if (segments.includes("..") || segments.includes("") || segments[0] === ".git") {
    warn(`${source}: skipping unsafe path '${raw}'`);
    return undefined;
  }
  return normalized;
}

async function isGitIgnored(workspaceRoot: string, relativePath: string, warn: Warn): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", relativePath], { cwd: workspaceRoot });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    warn(`worktree paths: could not check whether '${relativePath}' is gitignored; skipping it`);
    return false;
  }
}

async function isGitTracked(workspaceRoot: string, relativePath: string, warn: Warn): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--", relativePath], { cwd: workspaceRoot });
    return stdout.trim().length > 0;
  } catch {
    warn(`worktree paths: could not check whether '${relativePath}' is tracked; skipping it`);
    return true;
  }
}

async function admittedSharedDirectories(workspaceRoot: string, configured: readonly string[], warn: Warn): Promise<string[]> {
  const admitted: string[] = [];
  const seen = new Set<string>();
  for (const raw of configured) {
    const relativePath = literalPath(raw, "settings.worktree.sharedDirectories", warn);
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    let directory = false;
    try { directory = fs.statSync(path.join(workspaceRoot, relativePath)).isDirectory(); } catch { /* warned below */ }
    if (!directory) {
      warn(`settings.worktree.sharedDirectories: skipping '${relativePath}' because it is absent or not a directory in the primary checkout`);
      continue;
    }
    if (await isGitTracked(workspaceRoot, relativePath, warn)) {
      warn(`settings.worktree.sharedDirectories: skipping '${relativePath}' because tracked directories cannot be shared`);
      continue;
    }
    if (!(await isGitIgnored(workspaceRoot, relativePath, warn))) {
      warn(`settings.worktree.sharedDirectories: skipping '${relativePath}' because only gitignored directories can be shared`);
      continue;
    }
    admitted.push(relativePath);
  }
  return admitted;
}

async function worktreeIncludePaths(workspaceRoot: string, warn: Warn): Promise<string[]> {
  let content: string;
  try { content = fs.readFileSync(path.join(workspaceRoot, WORKTREE_INCLUDE_FILE), "utf8"); }
  catch { return []; }
  const admitted: string[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const relativePath = literalPath(raw, WORKTREE_INCLUDE_FILE, warn);
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    try { fs.lstatSync(path.join(workspaceRoot, relativePath)); }
    catch {
      warn(`${WORKTREE_INCLUDE_FILE}: skipping '${relativePath}' because it is absent in the primary checkout`);
      continue;
    }
    if (await isGitTracked(workspaceRoot, relativePath, warn)) {
      warn(`${WORKTREE_INCLUDE_FILE}: skipping '${relativePath}' because tracked paths cannot be copied`);
      continue;
    }
    if (!(await isGitIgnored(workspaceRoot, relativePath, warn))) {
      warn(`${WORKTREE_INCLUDE_FILE}: skipping '${relativePath}' because only gitignored paths can be copied`);
      continue;
    }
    admitted.push(relativePath);
  }
  return admitted;
}

function copyOwnPath(source: string, target: string): void {
  const actualSource = fs.lstatSync(source).isSymbolicLink() ? fs.realpathSync(source) : source;
  const stat = fs.statSync(actualSource);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: stat.mode });
    for (const entry of fs.readdirSync(actualSource)) {
      copyOwnPath(path.join(actualSource, entry), path.join(target, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(actualSource, target, process.platform === "darwin" ? fs.constants.COPYFILE_FICLONE : 0);
}

async function copyIncludedPaths(workspaceRoot: string, worktreePath: string, warn: Warn): Promise<void> {
  for (const relativePath of await worktreeIncludePaths(workspaceRoot, warn)) {
    const source = path.join(workspaceRoot, relativePath);
    const target = path.join(worktreePath, relativePath);
    try { fs.lstatSync(target); continue; } catch { /* missing target is the only write case */ }
    try { copyOwnPath(source, target); }
    catch (error) {
      warn(`${WORKTREE_INCLUDE_FILE}: could not copy '${relativePath}' (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

function linkSharedDirectory(workspaceRoot: string, worktreePath: string, relativePath: string, warn: Warn): void {
  const source = path.join(workspaceRoot, relativePath);
  const target = path.join(worktreePath, relativePath);
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() && path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(source)) return;
    warn(`settings.worktree.sharedDirectories: skipping '${relativePath}' because the worktree target already exists`);
    return;
  } catch { /* absent target */ }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, "dir");
  } catch (error) {
    warn(`settings.worktree.sharedDirectories: could not link '${relativePath}' (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Classify `<dir>/node_modules`. Only a symlink pointing at the EXPECTED target counts as ours; a
 * symlink anywhere else is `foreign`, because a link somebody else made is not ours to retarget.
 */
export function dependencyDirState(dir: string, expectedTarget: string, io: DependencyFsLike = nodeFs): DependencyDirState {
  const p = path.join(dir, DEPENDENCY_DIR);
  let st: { isSymbolicLink: () => boolean; isDirectory: () => boolean };
  try {
    st = io.lstat(p);
  } catch {
    return "absent"; // lstat only fails here when the entry is not there
  }
  if (!st.isSymbolicLink()) return "foreign";
  try {
    return path.resolve(dir, io.readlink(p)) === path.resolve(expectedTarget) ? "shared-link" : "foreign";
  } catch {
    return "foreign";
  }
}

/**
 * Decide and APPLY, for one worktree. Idempotent: run it on create and on every relaunch and it
 * converges — that is deliberate, because create and restart/resume are the same mechanism reached
 * through different doors, and a check that only ran at create would miss every rebase.
 *
 * Never throws for materialization failures: a refused link degrades to `absent` or a warning. An
 * isolated launch must not fail over an optimization.
 */
export async function shareDependencies(
  o: {
    workspaceRoot: string;
    worktreePath: string;
    /** No default: the repository must name every directory Tachyon may share. */
    sharedDirectories?: readonly string[];
    warn?: Warn;
    now?: () => string;
    io?: DependencyFsLike;
  },
): Promise<SharedDependencyState | undefined> {
  const io = o.io ?? nodeFs;
  const warn = o.warn ?? (() => {});
  const at = (o.now ?? (() => new Date().toISOString()))();
  await copyIncludedPaths(o.workspaceRoot, o.worktreePath, warn);
  const sharedDirectories = await admittedSharedDirectories(o.workspaceRoot, o.sharedDirectories ?? [], warn);
  for (const relativePath of sharedDirectories) {
    if (relativePath !== DEPENDENCY_DIR) linkSharedDirectory(o.workspaceRoot, o.worktreePath, relativePath, warn);
  }
  const target = path.join(o.workspaceRoot, DEPENDENCY_DIR);
  const linkPath = path.join(o.worktreePath, DEPENDENCY_DIR);
  const dirState = dependencyDirState(o.worktreePath, target, io);
  if (!sharedDirectories.includes(DEPENDENCY_DIR)) {
    // A checkout created under the retired implicit default may still carry our exact link. Absence
    // from the declaration now means "share nothing", so converge by removing only that known link.
    if (dirState === "shared-link") {
      try { io.unlink(linkPath); }
      catch (error) {
        warn(`settings.worktree.sharedDirectories: could not remove undeclared '${DEPENDENCY_DIR}' link (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return undefined;
  }
  const plan = planDependencySharing({
    primary: fingerprintLockfiles(readLockfiles(o.workspaceRoot, io)),
    worktree: fingerprintLockfiles(readLockfiles(o.worktreePath, io)),
    // Followed, not lstat'd: a primary checkout whose own `node_modules` is itself a link (a
    // pnpm store, a hand-made link) is still a directory worth pointing at.
    primaryHasDependencies: (() => {
      try { return io.stat(target).isDirectory(); } catch { return false; }
    })(),
    worktreeDir: dirState,
  });

  switch (plan.kind) {
    case "leave":
      // A declared node_modules without a lockfile can make no divergence claim. Leave a foreign
      // directory alone; otherwise this declaration has nothing safe to materialize.
      if (dirState !== "foreign") return undefined;
      return { mode: "own", lockDigest: plan.digest, reason: plan.reason, at };

    case "unshare":
      if (dirState !== "shared-link") return { mode: "absent", lockDigest: plan.digest, reason: plan.reason, at };
      try {
        io.unlink(linkPath);
      } catch (err) {
        // The link survived a divergence we detected. Keep saying `linked` — that is what is on disk
        // — and carry the divergence in the reason, so the failure is loud rather than downgraded to
        // an ordinary "no dependencies" the agent would quietly install over.
        return {
          mode: "linked",
          lockDigest: plan.digest,
          target,
          reason: `${plan.reason}; the shared ${DEPENDENCY_DIR} link could NOT be removed (${err instanceof Error ? err.message : String(err)}) — remove it before trusting any check run here`,
          at,
        };
      }
      return { mode: "absent", lockDigest: plan.digest, reason: `${plan.reason} (the stale shared ${DEPENDENCY_DIR} link was removed)`, at };

    case "link":
      if (dirState === "shared-link") return { mode: "linked", lockDigest: plan.digest, target, reason: plan.reason, at };
      try {
        io.symlink(target, linkPath);
      } catch (err) {
        return {
          mode: "absent",
          lockDigest: plan.digest,
          reason: `${DEPENDENCY_DIR} could not be linked to the primary checkout (${err instanceof Error ? err.message : String(err)})`,
          at,
        };
      }
      return { mode: "linked", lockDigest: plan.digest, target, reason: plan.reason, at };
  }
}
