/** Ambient types for scripts/dev-host/pointer.mjs (imported by unit tests). */

export interface DevHostPaths {
  root: string;
  extension: string;
  workspace: string;
  meta: string;
  userData: string;
  extensions: string;
  tmux: string;
  cache: string;
}

export interface DevHostPointOptions {
  repoRoot: string;
  worktree: string;
  workspace: string;
  spec?: string | null;
  slug?: string | null;
  owner?: string | null;
}

export interface DevHostMeta {
  schemaVersion: number;
  kind: "dev-host";
  worktree: string;
  workspace: string;
  extensionLink: string;
  workspaceLink: string;
  workspaceMirror?: boolean;
  spec: string | null;
  slug: string | null;
  owner: string | null;
  packageName: string | null;
  sha: string;
  nodeModulesLinked: boolean;
  preparedAt: string;
  launchConfig: string;
  howTo: string[];
  launchJson?: string;
  launchNote?: string;
  [key: string]: unknown;
}

export interface DevHostStatus {
  armed: boolean;
  reason?: string;
  meta?: DevHostMeta;
  extensionResolves?: string | null;
  /** Fixture source path (from .dev-host-source) or the mirror path. */
  workspaceResolves?: string | null;
  /** True when workspace is a real mirror dir with .dev-host-source marker. */
  workspaceIsMirror?: boolean;
  broken?: boolean;
}

export interface DevHostClearResult {
  cleared: boolean;
  reason?: string;
  launch?: { restored: boolean; reason?: string; path?: string };
}

export interface LaunchConfig {
  name: string;
  type: string;
  request: string;
  args: string[];
  env: Record<string, string>;
  outFiles: string[];
  preLaunchTask: string;
  presentation: { hidden: boolean; group: string; order: number };
}

export function defaultRepoRoot(fromFile?: string): string;
export function devHostDir(repoRoot: string): string;
export function pathsOf(repoRoot: string): DevHostPaths;
export function assertWorkspaceNotRepoRoot(workspaceAbs: string, repoRootAbs: string): void;
export function assertWorktreeLooksValid(worktreeAbs: string): string;
export function assertWorkspaceDir(workspaceAbs: string): string;
export function materializeWorkspaceMirror(mirrorDir: string, fixtureAbs: string): string;
export function ensureNodeModules(
  worktreeAbs: string,
  repoRootAbs: string,
): { linked: boolean };
export function portableDevHostLaunchConfig(): LaunchConfig;
/** @deprecated Prefer ensurePortableLaunchConfig */
export function writeAbsoluteLaunchConfig(
  repoRoot: string,
  worktreeAbs?: string,
  workspaceAbs?: string,
): string | null;
export function ensurePortableLaunchConfig(repoRoot: string): string | null;
export function restoreTemplateLaunchConfig(
  repoRoot: string,
): { restored: boolean; reason?: string; path?: string };
export function point(opts: DevHostPointOptions): DevHostMeta;
export function status(repoRoot: string): DevHostStatus;
export function clear(repoRoot: string): DevHostClearResult;
export function parseArgs(argv: string[]): Record<string, string | string[] | undefined> & { _: string[] };
export function main(argv?: string[]): number;
