import type { WorkspaceClient } from "./WorkspaceClient.js";

/** Narrow identity contract shared by editor panels during the shell cutover. */
export interface WorkspacePresentationTarget {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
}

export function workspacePresentationTarget(client: WorkspaceClient): WorkspacePresentationTarget {
  const workspace = client.presentation.workspace;
  return {
    workspaceRoot: workspace.root,
    wsHash: workspace.hash,
    folderName: workspace.folderName,
  };
}
