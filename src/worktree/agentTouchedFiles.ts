/**
 * t-75e9c7 — "which files has each live agent already touched?", answered from the one place that
 * cannot lie: the agent's own worktree. A Temporary is born on its own branch in its own worktree
 * (spec 210), so what it has touched is baseRef↔working-tree, not baseRef↔HEAD — an agent with zero
 * commits still has real edits on disk, and a commit-only diff would report it as untouched. That is
 * exactly the manual list this replaces getting it wrong in the one case that matters most (a freshly
 * spawned agent, mid-edit, not yet committed).
 *
 * `WorktreeManager.changedFiles` (spec 213) already computes the right diff — working-tree compare
 * vs `baseRef`, tracked + untracked, rename/copy-aware. This module only shapes "one row per live
 * agent" on top of it, and says so honestly when an agent has no isolated worktree to diff at all
 * (a shared-checkout agent is not "touched nothing" — it is a different, unmeasurable case).
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
}

export interface AgentTouchedFilesGitPort {
  changedFiles(cwd: string, baseRef: string): Promise<ChangedFile[]>;
}

export interface AgentTouchedFilesEntry {
  agent: string;
  worktree: boolean;
  branch?: string;
  baseRef?: string;
  files: ChangedFile[];
  /** present only when `worktree` is false — files is [] there but it does NOT mean "touched nothing" */
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
          note: "no isolated worktree — this agent shares a checkout, so its touched files cannot be derived from a branch diff",
        };
      }
      const files = await git.changedFiles(wt.path, wt.baseRef);
      return { agent: a.name, worktree: true, branch: wt.branch, baseRef: wt.baseRef, files };
    }),
  );
}
