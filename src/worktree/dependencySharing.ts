/**
 * t-3f93b4 — a fresh worktree is born without the dependencies the primer tells its agent to use.
 *
 * The contradiction this module closes: Tachyon injects a primer into EVERY spawn that says "run
 * `settings.verify.typecheck`" and "use focused tests while implementing", and then hands the agent
 * a checkout where neither command can run. Measured on 2026-08-02 with three delegated children
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
 * Pure decision + a thin injected-fs applier, so the whole matrix table-tests with no real
 * filesystem, mirroring how `verify.ts` splits its pure gate from `Workspace.runVerify`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The directory two checkouts of one repo can share, and the files that decide whether they may.
 *
 * One ecosystem on purpose. Node is where the measured 478 MB lives, `node_modules` is the only
 * dependency directory that is both path-independent and reproducible from a lockfile alone, and a
 * speculative table of every package manager would be hardening nobody asked for. Every recognized
 * lockfile is listed because ANY of them appearing on one side and not the other is divergence —
 * yarn/pnpm/bun all populate the same `node_modules`, so the digest has to see them.
 */
export const DEPENDENCY_DIR = "node_modules";
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
 * Persisted on the WorktreeRecord (mirrors `verify`): the decision, and the digest that justified it.
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

/**
 * One sentence for the agent's primer — the half of this task that is a CONTRACT rather than an
 * optimization. Either the product shares the dependencies and says the terms, or it says the agent
 * will have to install and why; what it must never do again is stay silent and let each agent
 * rediscover the gap and answer it differently.
 */
export function describeDependencyState(state: SharedDependencyState | undefined, installHint?: string): string | undefined {
  if (!state) return undefined;
  if (state.mode === "linked") {
    return `Dependencies: ${DEPENDENCY_DIR} is a symlink to the primary checkout (${state.reason}). Do not reinstall through it — if you change dependencies, replace the link with your own install and say so in your report.`;
  }
  if (state.mode === "own") {
    return `Dependencies: this worktree has its own ${DEPENDENCY_DIR} — ${state.reason}.`;
  }
  const hint = installHint?.trim();
  return `Dependencies: this worktree has no ${DEPENDENCY_DIR} — ${state.reason}. Install${hint ? ` (${hint})` : ""} before running the configured checks.`;
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
 * Never throws: a filesystem that refuses the link degrades to `absent` with the error in the reason,
 * which the agent then reads in its primer. An isolated launch must not fail over an optimization.
 */
export function shareDependencies(
  o: { workspaceRoot: string; worktreePath: string; now?: () => string; io?: DependencyFsLike },
): SharedDependencyState | undefined {
  const io = o.io ?? nodeFs;
  const at = (o.now ?? (() => new Date().toISOString()))();
  const target = path.join(o.workspaceRoot, DEPENDENCY_DIR);
  const linkPath = path.join(o.worktreePath, DEPENDENCY_DIR);
  const dirState = dependencyDirState(o.worktreePath, target, io);
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
      // A worktree with no lockfile anywhere is not a Node project; saying anything about its
      // dependencies would be inventing a fact, so it gets no state and the primer gets no line.
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

/**
 * Re-measure a recorded decision against the checkout as it is NOW. Returns undefined when the
 * recorded state still holds; otherwise the divergence sentence to say out loud.
 *
 * This is the door a mid-session edit comes through. Creation and relaunch are the doors Tachyon
 * already owns; a lockfile the agent edits at 10:00 reaches neither, so anything that turns a run in
 * this worktree into a DURABLE verdict has to ask again first. Cheap by construction: two lockfile
 * reads and a hash.
 */
export function auditSharedDependencies(
  o: { workspaceRoot: string; worktreePath: string; state: SharedDependencyState | undefined; io?: DependencyFsLike },
): string | undefined {
  if (o.state?.mode !== "linked") return undefined;
  const io = o.io ?? nodeFs;
  const target = path.join(o.workspaceRoot, DEPENDENCY_DIR);
  if (dependencyDirState(o.worktreePath, target, io) !== "shared-link") return undefined; // no longer ours to speak for
  const now = fingerprintLockfiles(readLockfiles(o.worktreePath, io));
  if (now.digest === o.state.lockDigest) return undefined;
  return (
    `${DEPENDENCY_DIR} is shared with the primary checkout for lockfile ${o.state.lockDigest.slice(0, 12)}, ` +
    `but this worktree's lockfile is now ${now.digest.slice(0, 12)} — the shared dependencies no longer match this branch`
  );
}
