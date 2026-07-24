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
  containedInBase: boolean;
  occupant?: WorktreeOccupancy;
}

export interface ClassifyWorktreeDeps {
  git?: GitExec;
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
  const probeFailed = status.aheadOfBase < 0;
  const dirty = probeFailed || status.staged > 0 || status.unstaged > 0 || status.untracked > 0 || status.conflicts > 0;
  const aheadOfBase = Math.max(0, status.aheadOfBase);
  const containedInBase = !probeFailed && (await isContainedInBase(git, entry.path, entry.baseRef, aheadOfBase));

  if (occupant) {
    return {
      state: "occupied",
      reasons: [`occupied by '${occupant.agent}' (${occupant.state})`],
      pathExists: true,
      dirty,
      aheadOfBase,
      containedInBase,
      occupant,
    };
  }

  const reasons: string[] = [];
  if (probeFailed) reasons.push("git status probe failed — treated as unsafe");
  else if (dirty) reasons.push("worktree has uncommitted changes");
  if (!probeFailed && !containedInBase) reasons.push(`${aheadOfBase} commit(s) not contained in base`);

  if (reasons.length === 0) {
    return { state: "ready-to-remove", reasons: [], pathExists: true, dirty, aheadOfBase, containedInBase };
  }
  return { state: "needs-review", reasons, pathExists: true, dirty, aheadOfBase, containedInBase };
}
