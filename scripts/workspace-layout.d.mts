export interface WorkspaceManifestEntry {
  directory: string;
  manifest: Record<string, any>;
}

export function workspaceDirectories(repositoryRoot: string): string[];
export function workspaceManifests(repositoryRoot: string): WorkspaceManifestEntry[];
export function extensionWorkspace(repositoryRoot: string): WorkspaceManifestEntry;
export function productSourceRoots(repositoryRoot: string): string[];
