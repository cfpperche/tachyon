/**
 * Persisted record of a Tachyon-managed checkout (t-e2a166).
 *
 * This is durable domain data: it travels in the session ledger, pipeline run
 * state, and the managed-worktree registry. It is not Git-operation vocabulary.
 * `WorktreeManager` creates and mutates checkouts; it does not own this shape.
 */
import type { WorktreeEvidence } from "./evidence.js";
import type { SharedDependencyState } from "./dependencySharing.js";

/** Persisted source of truth for cleanup + diff review. Never recomputed from possibly drifted config. */
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
  /**
   * t-3f93b4 — whether this checkout's `node_modules` is shared with the primary, and the lockfile
   * digest that made sharing legitimate. Persisted because the value is a
   * claim about a commit-shaped state, so it has to travel with the record that outlives the launch
   * in order for a later divergence to be a COMPARISON rather than a guess.
   */
  dependencies?: SharedDependencyState;
  /** spec 273 — the neutral non-binary evidence channel (bounded; HEAD-only staleness, never a gate). */
  evidence?: WorktreeEvidence[];
}
