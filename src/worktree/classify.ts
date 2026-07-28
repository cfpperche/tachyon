/**
 * spec 444 — fail-closed classification for a ManagedWorktreeEntry, composing signals already
 * proven at spec 392/365/398 (path existence, dirty/ahead-of-base, occupancy, branch ownership,
 * base-containment) into one of four algorithmic states. "active" (the registry's own `status`
 * field, spec 392) stays a separate, unchanged axis shown alongside — see notes.md.
 *
 * Deliberately does NOT import from `../git-delivery/classify.js`: that module's containment check
 * is coupled to the `GitDelivery` type. The underlying git operation is small and stable enough to
 * port against primitive `(cwd, baseRef)` args instead of widening spec 365's shipped code for a
 * spec 444 concern.
 */

import fs from "node:fs";
import type { GitExec, WorktreeOccupancy, WorktreeStatus } from "./WorktreeManager.js";
import { defaultGitExec } from "./WorktreeManager.js";
import type { ManagedWorktreeEntry } from "./managedWorktree.js";

export type WorktreeClassificationState = "record-only" | "ready-to-remove" | "needs-review" | "occupied";

export interface WorktreeClassification {
  state: WorktreeClassificationState;
  /** Human-readable reasons backing `state` — always non-empty for `needs-review`. */
  reasons: string[];
  pathExists: boolean;
  dirty: boolean;
  aheadOfBase: number;
  /**
   * t-6ae9a8 — HISTORICAL AND INFORMATIONAL ONLY. `baseRef` is the ref the worktree was CREATED from,
   * so it goes stale the moment anything lands on the trunk: a fully-landed worktree reads as "N
   * commits not contained in base" purely because the trunk moved past its birth point. Kept for
   * diagnostics; never the basis of a safety decision.
   */
  containedInBase: boolean;
  /**
   * t-6ae9a8 — the AUTHORITATIVE containment signal: is HEAD contained in the CURRENT trunk. This is
   * the question a removal decision actually depends on — "has this work arrived where it was going",
   * not "was it born recently". Fail-closed: an unresolvable trunk reads as NOT contained.
   */
  containedInTrunk: boolean;
  /** The trunk ref containment was measured against, so a reason line can name it. */
  trunkRef: string;
  occupant?: WorktreeOccupancy;
}

export interface ClassifyWorktreeDeps {
  git?: GitExec;
  /**
   * t-6ae9a8 — the trunk to measure containment against. Defaults to `main`, which is this
   * repository's trunk; injectable so a test can pin it and a fork can name a different one.
   */
  trunkRef?: string;
  /** Dirty/ahead-of-base probe — the same signature as `WorktreeManager.status`. */
  status: (cwd: string, baseRef: string) => Promise<WorktreeStatus>;
  /** Live-agent occupancy probe — the same signature as `AgentManager.worktreeOccupant`. */
  occupancy?: (worktreePath: string) => Promise<WorktreeOccupancy | undefined>;
  pathExists?: (p: string) => boolean;
}

/** Mirrors git-delivery/classify.ts's patchesAllInBase: every `git cherry` line is an already-equivalent ('-') patch. */
function patchesAllInBase(cherry: { code: number; stdout: string }): boolean {
  return cherry.code === 0 && cherry.stdout.split("\n").every((line) => line.trim() === "" || !line.trim().startsWith("+"));
}

/**
 * Is `cwd`'s HEAD contained in `baseRef` — either as a real ancestor (the common case, already
 * known from `status.aheadOfBase === 0`) or, when it has commits ahead, because every one of those
 * commits' patches is already present in base (cherry-picked/squash-merged without a fast-forward).
 * Best-effort: any probe failure reads as NOT contained (fail-closed — never claims safety it can't prove).
 */
async function isContainedInBase(git: GitExec, cwd: string, baseRef: string, aheadOfBase: number): Promise<boolean> {
  if (aheadOfBase === 0) return true;
  try {
    const head = await git(["rev-parse", "HEAD"], cwd);
    if (head.code !== 0 || !head.stdout.trim()) return false;
    const cherry = await git(["cherry", baseRef, head.stdout.trim()], cwd);
    return patchesAllInBase(cherry);
  } catch {
    return false;
  }
}

/**
 * t-6ae9a8 — is HEAD contained in `ref` RIGHT NOW, resolving the ref itself rather than trusting a
 * recorded one.
 *
 * This is the question that decides whether a worktree is discardable, and the reason the previous
 * check answered the wrong one: it compared against the CREATION baseRef, which every landing makes
 * older. Measured on this host — eight clean worktrees whose commits were all in `main` were each
 * reported as "N commits not contained in base", so nothing could reclaim them and they accumulated
 * with a full `node_modules` apiece.
 *
 * Two ways to be contained, both accepted: a true ancestor (the fast-forward case), or every commit's
 * patch already present (squash-merged or cherry-picked, where no ancestry survives). The second is
 * why `git cherry` is used rather than `merge-base --is-ancestor` alone.
 *
 * FAIL-CLOSED at every exit. An unresolvable ref, a failed probe, a thrown call — all read as NOT
 * contained, because the entire value of this signal is that it never claims a safety it cannot
 * demonstrate. Loosening that would turn a cleanup into data loss.
 */
async function isContainedInRef(git: GitExec, cwd: string, ref: string): Promise<boolean> {
  try {
    const resolved = await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
    if (resolved.code !== 0 || !resolved.stdout.trim()) return false;
    const head = await git(["rev-parse", "HEAD"], cwd);
    if (head.code !== 0 || !head.stdout.trim()) return false;
    const ancestor = await git(["merge-base", "--is-ancestor", head.stdout.trim(), resolved.stdout.trim()], cwd);
    if (ancestor.code === 0) return true;
    const cherry = await git(["cherry", resolved.stdout.trim(), head.stdout.trim()], cwd);
    return patchesAllInBase(cherry);
  } catch {
    return false;
  }
}

export async function classifyManagedWorktree(
  entry: ManagedWorktreeEntry,
  deps: ClassifyWorktreeDeps,
): Promise<WorktreeClassification> {
  const pathExists = (deps.pathExists ?? fs.existsSync)(entry.path);
  if (!pathExists) {
    return {
      state: "record-only",
      reasons: ["path does not exist"],
      pathExists: false,
      dirty: false,
      aheadOfBase: 0,
      containedInBase: false,
      containedInTrunk: false,
      trunkRef: deps.trunkRef ?? "main",
    };
  }

  const git = deps.git ?? defaultGitExec;
  const occupant = await deps.occupancy?.(entry.path).catch(() => undefined);
  const status = await deps.status(entry.path, entry.baseRef).catch(
    (): WorktreeStatus => ({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      detached: false,
      branch: null,
      aheadOfBase: -1, // sentinel: probe failed — never treat as "0 ahead / safe"
      unpushed: 0,
      hasUpstream: false,
    }),
  );
  // Two distinct probe-failure shapes, both fail-closed (adversarial-review blocker): the status()
  // PROMISE rejecting (our own -1 sentinel above), and status() RESOLVING with aheadProbeFailed —
  // WorktreeManager.status never rejects when `rev-list baseRef..HEAD` itself fails (unresolvable/
  // deleted baseRef); it best-effort-coerces aheadOfBase to 0, which must never read as "contained".
  const probeFailed = status.aheadOfBase < 0 || status.aheadProbeFailed === true;
  const dirty = probeFailed || status.staged > 0 || status.unstaged > 0 || status.untracked > 0 || status.conflicts > 0;
  const aheadOfBase = Math.max(0, status.aheadOfBase);
  const containedInBase = !probeFailed && (await isContainedInBase(git, entry.path, entry.baseRef, aheadOfBase));
  // t-6ae9a8 — measured against the CURRENT trunk, and deliberately NOT gated on `probeFailed`. That
  // flag means the recorded baseRef could not be resolved or `status` failed against it, which says
  // nothing about the trunk: a worktree whose birth ref was deleted can still be entirely landed.
  // Keeping the trunk probe independent is what lets a stale baseRef stop blocking cleanup.
  const trunkRef = deps.trunkRef ?? "main";
  const containedInTrunk = await isContainedInRef(git, entry.path, trunkRef);

  if (occupant) {
    return {
      state: "occupied",
      reasons: [`occupied by '${occupant.agent}' (${occupant.state})`],
      pathExists: true,
      dirty,
      aheadOfBase,
      containedInBase,
      containedInTrunk,
      trunkRef,
      occupant,
    };
  }

  const reasons: string[] = [];
  const statusRejected = status.aheadOfBase < 0;
  const genuinelyDirty = status.staged > 0 || status.unstaged > 0 || status.untracked > 0 || status.conflicts > 0;
  // A `git status` that could not run at all still blocks: without it we do not know whether there is
  // uncommitted work, and that is a data-loss question no containment result can answer.
  if (statusRejected) reasons.push("git status probe failed — treated as unsafe");
  if (!statusRejected && genuinelyDirty) reasons.push("worktree has uncommitted changes");
  // t-6ae9a8 — the ONE containment reason, and it names the trunk. An unresolvable creation baseRef is
  // no longer a blocker on its own: it is a fact about where the worktree was born, and being born
  // from a ref that has since been deleted says nothing about whether the work arrived. What blocks is
  // failing to prove the work is IN the trunk.
  // t-6ae9a8 — EITHER proof is sufficient, and that is the whole fix. Two independent ways for removal
  // to lose nothing:
  //   · contained in the recorded base — the work is present in the ref this worktree branched from;
  //   · contained in the current trunk — the work has since landed where it was going.
  // The old check demanded the first and only the first, so every landing made a clean worktree look
  // MORE unsafe rather than less. Requiring both would be stricter than the safety argument needs;
  // requiring only the stale one is what accumulated eight of them here.
  const contained = containedInBase || containedInTrunk;
  // When `git status` itself failed we do not know how many commits are ahead, so appending a
  // containment count would be noise on top of the one fact that matters: the probe did not run.
  // The status failure already blocks, and it is the actionable line.
  if (!contained && !statusRejected) {
    // Only now does an unresolvable base matter: with no trunk proof either, nothing establishes that
    // the commits are recoverable, and that is exactly when the classifier must refuse.
    if (!statusRejected && status.aheadProbeFailed === true) {
      reasons.push(`base ref '${entry.baseRef}' could not be resolved and HEAD is not in '${trunkRef}' — ancestry unknown, treated as unsafe`);
    } else {
      reasons.push(`${aheadOfBase} commit(s) not contained in base or in '${trunkRef}'`);
    }
  }

  const shape = { pathExists: true, dirty, aheadOfBase, containedInBase, containedInTrunk, trunkRef } as const;
  if (reasons.length === 0) return { state: "ready-to-remove", reasons: [], ...shape };
  return { state: "needs-review", reasons, ...shape };
}
