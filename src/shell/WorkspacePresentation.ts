import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { GitExec } from "../worktree/WorktreeManager.js";

/** Narrow identity contract shared by editor panels during the shell cutover. */
export interface WorkspacePresentationTarget {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
}

export interface WorkspaceGitPresentationTarget extends WorkspacePresentationTarget {
  gitExec: GitExec;
}

export function workspacePresentationTarget(client: WorkspaceClient): WorkspacePresentationTarget {
  const workspace = client.presentation.workspace;
  return {
    workspaceRoot: workspace.root,
    wsHash: workspace.hash,
    folderName: workspace.folderName,
  };
}

export function workspaceGitPresentationTarget(
  client: WorkspaceClient,
  gitExec: GitExec,
): WorkspaceGitPresentationTarget {
  return { ...workspacePresentationTarget(client), gitExec };
}
