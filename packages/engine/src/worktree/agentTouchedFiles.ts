/**
 * t-75e9c7 — "which files has each live agent already touched?", answered from the one place that
 * cannot lie: the agent's own worktree. A Temporary is born on its own branch in its own worktree
 * (spec 210), so what it has touched is merge-base(current base branch, HEAD)↔working-tree, not a
 * commit-only branch diff — an agent with zero commits still has real edits on disk, and a commit-only
 * diff would report it as untouched. The current merge-base matters for a long-lived worktree: its
 * recorded creation base ages as the branch catches up with main and would otherwise turn main's
 * movement into files falsely attributed to the agent (t-004255).
 *
 * `WorktreeManager.changedFiles` (spec 213) computes the working-tree comparison, tracked +
 * untracked and rename/copy-aware. This module chooses its comparison ref, shapes "one row per live
 * agent", and says so honestly when an agent has no separate worktree or a legacy worktree has no
 * recorded base branch from which to remove branch drift.
 */
import type { ChangedFile } from "./review.js";

export interface AgentTouchedFilesRow {
  name: string;
  running: boolean;
}

export interface AgentWorktreeLocation {
  path: string;
  branch: string;
  baseRef: string;
  baseBranch?: string;
}

export interface AgentTouchedFilesGitPort {
  changedFiles(cwd: string, baseRef: string): Promise<ChangedFile[]>;
  mergeBase?(cwd: string, leftRef: string, rightRef: string): Promise<string | undefined>;
}

export interface AgentTouchedFilesEntry {
  agent: string;
  worktree: boolean;
  branch?: string;
  baseRef?: string;
  baseBranch?: string;
  comparisonRef?: string;
  files: ChangedFile[];
  /** Present when the file list needs qualification; an empty list does not override this note. */
  note?: string;
}

/**
 * One row per LIVE (running) agent. Order follows `agents` as given — callers that want it sorted
 * sort it themselves. A dead/stopped entry is not "live" and is excluded, not reported empty.
 */
export async function collectAgentTouchedFiles(
  agents: readonly AgentTouchedFilesRow[],
  lookupWorktree: (agent: string) => AgentWorktreeLocation | undefined,
  git: AgentTouchedFilesGitPort,
): Promise<AgentTouchedFilesEntry[]> {
  const live = agents.filter((a) => a.running);
  return Promise.all(
    live.map(async (a): Promise<AgentTouchedFilesEntry> => {
      const wt = lookupWorktree(a.name);
      if (!wt) {
        return {
          agent: a.name,
          worktree: false,
          files: [],
          note: "no separate worktree — this agent shares a checkout, so its touched files cannot be derived from a branch diff",
        };
      }
      let comparisonRef = wt.baseRef;
      let note: string | undefined;
      if (!wt.baseBranch) {
        note = "creation-base diff — this legacy worktree has no recorded base branch, so the files may include branch drift since the agent was created";
      } else if (!git.mergeBase) {
        note = `creation-base diff — current merge-base with '${wt.baseBranch}' is unavailable, so the files may include branch drift since the agent was created`;
      } else {
        const currentMergeBase = await git.mergeBase(wt.path, "HEAD", wt.baseBranch);
        if (currentMergeBase) {
          comparisonRef = currentMergeBase;
        } else {
          note = `creation-base diff — '${wt.baseBranch}' and HEAD have no resolvable merge-base, so the files may include branch drift since the agent was created`;
        }
      }
      const files = await git.changedFiles(wt.path, comparisonRef);
      return {
        agent: a.name,
        worktree: true,
        branch: wt.branch,
        baseRef: wt.baseRef,
        ...(wt.baseBranch ? { baseBranch: wt.baseBranch } : {}),
        comparisonRef,
        files,
        ...(note ? { note } : {}),
      };
    }),
  );
}
