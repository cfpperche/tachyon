/** Ambient types for scripts/dev-host/pointer.mjs (imported by unit tests). */

import type { ProbeFixtureEngineResult, StopFixtureBridgeResult, StopFixtureEngineResult } from "./stop-bridge.d.mts";

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

export interface DevHostFixtureNewOptions {
  repoRoot: string;
  worktree?: string | null;
  slug: string;
  spec?: string | null;
  intent?: "focus" | "metrics" | string | null;
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
  [key: string]: unknown;
}

export interface DevHostStatus {
  armed: boolean;
  reason?: string;
  meta?: DevHostMeta;
  extensionResolves?: string | null;
  /** Fixture source path (from .dev-host-source) or the mirror path. */
  workspaceResolves?: string | null;
  /** Absolute path of the real mirror directory under .tachyon/dev-host/workspace. */
  workspaceMirrorPath?: string | null;
  /** True when workspace is a real mirror dir with .dev-host-source marker. */
  workspaceIsMirror?: boolean;
  worktreePath?: string | null;
  worktreeExists?: boolean;
  distExists?: boolean;
  /** true = real dir, false = symlink/missing when expected, null = fixture had no .tachyon */
  tachyonMirrorIsRealDir?: boolean | null;
  fixtureSourceExists?: boolean;
  fixtureDrift?: boolean;
  /** Read-only point-status/Doctor diagnostic (t-e357dc) — never stops anything. */
  engineOccupant?: ProbeFixtureEngineResult | { state: "unknown"; error: string } | null;
  warnings?: string[];
  broken?: boolean;
}

export interface DevHostReconcileResult {
  engine: StopFixtureEngineResult;
  bridge: StopFixtureBridgeResult;
}

export interface DevHostReconcileOptions {
  stopEngine?: (fixtureRoot: string) => Promise<StopFixtureEngineResult>;
  stopBridge?: (fixtureRoot: string) => Promise<StopFixtureBridgeResult>;
}

export interface DevHostStatusOptions {
  probeEngine?: (fixtureRoot: string) => Promise<ProbeFixtureEngineResult>;
}

export interface DevHostClearResult {
  cleared: boolean;
  reason?: string;
  reconciled?: DevHostReconcileResult;
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
export function ensureWorktreeToolBin(
  worktreeAbs: string,
  repoRootAbs: string,
): { linked: boolean; count: number; reason?: string };
export function resolveFixturePath(opts: {
  worktree?: string | null;
  repoRoot?: string | null;
  fixture: string;
}): string;
export function fixtureNew(opts: DevHostFixtureNewOptions): {
  root: string;
  slug: string;
  intent: string;
  spec: string | null;
};
export function printStatus(st: DevHostStatus): void;
/**
 * spec 448 — locates the PRIMARY checkout so this one can borrow `node_modules` / `.tachyon/bin`.
 * It never selects a dev-host root: the dev-host belongs to the checkout it serves.
 */
export function resolvePrimaryRepoRoot(
  fromCheckout: string,
  opts?: { readGitCommonDir?: (checkout: string) => string },
): { primaryRepo: string; checkout: string; redirected: boolean; warning?: string };
export function point(opts: DevHostPointOptions): DevHostMeta;
export function status(repoRoot: string, opts?: DevHostStatusOptions): Promise<DevHostStatus>;
export function clear(repoRoot: string, opts?: DevHostReconcileOptions): Promise<DevHostClearResult>;
export function reconcileDevHostOccupant(
  repoRoot: string,
  opts?: DevHostReconcileOptions,
): Promise<DevHostReconcileResult>;
export function parseArgs(argv: string[]): Record<string, string | string[] | undefined> & { _: string[] };
export function main(argv?: string[]): Promise<number>;
