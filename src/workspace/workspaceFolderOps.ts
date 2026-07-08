/**
 * spec 210/263 — pure decision core for revealing agent worktrees in the VS Code file tree.
 * NO vscode import: the applier (src/extension.ts) is a thin layer over this that calls
 * vscode.workspace.updateWorkspaceFolders per the ops this computes.
 *
 * `remove` self-heals orphans too: a folder under `worktreesBase` with no matching live
 * worktree is removed whether it was just cleaned up OR is stale from a prior reload (the
 * .code-workspace file persists folders across reloads; a worktree gone by the time the
 * window comes back up would otherwise sit there forever).
 */

import path from "node:path";

export interface WorkspaceFolderLike {
  path: string;
  name: string;
}

export interface LiveWorktree {
  path: string;
  agent: string;
}

export interface WorkspaceFolderOps {
  add: WorkspaceFolderLike[];
  remove: number[]; // indices into currentFolders
}

function normalize(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, "");
}

function isUnderBase(folderPath: string, base: string): boolean {
  const rel = path.relative(normalize(base), normalize(folderPath));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function computeWorkspaceFolderOps(
  currentFolders: WorkspaceFolderLike[],
  liveWorktrees: LiveWorktree[],
  worktreesBase: string,
): WorkspaceFolderOps {
  const currentPaths = new Set(currentFolders.map((f) => normalize(f.path)));
  const livePaths = new Set(liveWorktrees.map((w) => normalize(w.path)));

  const add: WorkspaceFolderLike[] = [];
  const seenAdds = new Set<string>();
  for (const wt of liveWorktrees) {
    const norm = normalize(wt.path);
    if (currentPaths.has(norm) || seenAdds.has(norm)) continue;
    seenAdds.add(norm);
    add.push({ path: wt.path, name: wt.agent });
  }

  const remove: number[] = [];
  currentFolders.forEach((f, i) => {
    if (isUnderBase(f.path, worktreesBase) && !livePaths.has(normalize(f.path))) remove.push(i);
  });

  return { add, remove };
}
