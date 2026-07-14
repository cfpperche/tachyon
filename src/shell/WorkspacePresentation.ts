import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { GitExec } from "../worktree/WorktreeManager.js";
import type { TachyonConfig } from "../config/loadConfig.js";
import type { StudioDeps, StudioSubmit } from "../webview/studioSubmit.js";

/** Narrow identity contract shared by editor panels during the shell cutover. */
export interface WorkspacePresentationTarget {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
}

export interface WorkspaceGitPresentationTarget extends WorkspacePresentationTarget {
  gitExec: GitExec;
}

/**
 * Transitional Studio host contract. The editor owns the panels while config
 * persistence remains behind this narrow seam during the persistent-engine
 * cutover; callers must not depend on the concrete Workspace lifecycle.
 */
export interface WorkspaceStudioTarget extends WorkspacePresentationTarget {
  readonly config: TachyonConfig | undefined;
  studioDeps(): StudioDeps;
  studioSubmit(submit: StudioSubmit): string[] | undefined | Promise<string[] | undefined>;
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
