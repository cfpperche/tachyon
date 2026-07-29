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

/**
 * True when `folderPath` sits under the Tachyon worktrees base — the same test used to
 * decide what this module reveals/self-heals. Reused by extension.ts activation (both the
 * startup loop and the live workspace-folders watcher) to keep worktree folders VIEW-ONLY:
 * they show files in the tree but never boot a Bridge/tmux/agent instance of their own.
 */
export function isUnderWorktreesBase(folderPath: string, base: string): boolean {
  const rel = path.relative(normalize(base), normalize(folderPath));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Pure activation decision (spec: t-2a73d6): a folder only boots a full Tachyon instance
 * (Bridge + tmux engine + declared agents) when it carries a config AND is NOT itself a
 * Tachyon-managed worktree folder. Every worktree is a checkout of the repo and so carries
 * its own tachyon.yml — without this guard, revealing a worktree (see above) would spawn a
 * phantom second Bridge/tmux/agent-tree per worktree instead of staying view-only.
 */
export function shouldActivateFolder(hasConfig: boolean, folderPath: string, worktreesBase: string): boolean {
  return hasConfig && !isUnderWorktreesBase(folderPath, worktreesBase);
}

/** One workspace's live worktrees plus whether that project wants them revealed. */
export interface WorkspaceWorktrees {
  /** `settings.worktree.revealInWorkspace`; `undefined` means the project never said, i.e. yes. */
  revealInWorkspace?: boolean;
  worktrees: LiveWorktree[];
}

/**
 * t-aaad95 — apply `revealInWorkspace` PER OWNING PROJECT, which is what moving it out of a
 * window-scoped VS Code key and into each project's `tachyon.yml` was for.
 *
 * A single window-level yes/no is wrong whichever way it is spelled: "reveal only if nobody objects"
 * lets one project hide every other project's worktrees, and "reveal if anybody wants it" reveals the
 * worktrees of a project that explicitly said not to. Filtering at the source gives each project
 * exactly what it asked for — and because `computeWorkspaceFolderOps` removes any folder under the
 * base that is not in the live set, a project that LATER opts out has its folders removed rather than
 * left behind.
 */
export function revealableWorktrees(perWorkspace: readonly WorkspaceWorktrees[]): LiveWorktree[] {
  return perWorkspace
    .filter((ws) => ws.revealInWorkspace !== false)
    .flatMap((ws) => ws.worktrees);
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
    if (isUnderWorktreesBase(f.path, worktreesBase) && !livePaths.has(normalize(f.path))) remove.push(i);
  });

  return { add, remove };
}
