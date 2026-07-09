/**
 * spec t-e5f75d — resolve the git BINARY to spawn instead of relying on bare `'git'` on the
 * extension host's PATH. A reload with a truncated PATH (no `/usr/bin`) otherwise breaks every
 * git op (worktree create/remove, plugin fetch) with a cryptic ENOENT. Shared by
 * WorktreeManager's `defaultGitExec` and the plugin fetcher's `defaultGitRun`.
 */

import fs from "node:fs";
import * as vscode from "vscode";

/** Common install locations to probe, in order, when nothing is configured. */
const DEFAULT_PROBE_LOCATIONS = ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"];

export interface GitBinaryInputs {
  /** the `tachyon.gitPath` VS Code setting, if configured. */
  configuredPath?: string;
  /** the built-in git extension's `git.path` setting — a single path or a list (first entry wins). */
  gitExtensionPath?: string | string[] | null;
  /** common install locations to probe, in order (overridable for tests). */
  probeLocations?: string[];
  /** injectable `fs.existsSync`-alike, for tests. */
  pathExists?: (p: string) => boolean;
}

/**
 * Resolve the git binary to spawn, in order: `tachyon.gitPath` setting > the VS Code git
 * extension's `git.path` > the first common install location that exists on disk > bare `'git'`
 * (PATH). Pure/sync — cheap to call before every spawn, and unit-testable without touching the
 * real fs or vscode.
 */
export function resolveGitBinary(inputs: GitBinaryInputs = {}): string {
  const configured = inputs.configuredPath?.trim();
  if (configured) return configured;

  const extRaw = Array.isArray(inputs.gitExtensionPath) ? inputs.gitExtensionPath[0] : inputs.gitExtensionPath;
  const ext = extRaw?.trim();
  if (ext) return ext;

  const exists = inputs.pathExists ?? fs.existsSync;
  for (const loc of inputs.probeLocations ?? DEFAULT_PROBE_LOCATIONS) {
    if (exists(loc)) return loc;
  }
  return "git";
}

/** Read the live `tachyon.gitPath` + git extension `git.path` settings and resolve the binary to spawn. */
export function currentGitBinary(): string {
  const configuredPath = vscode.workspace.getConfiguration("tachyon").get<string>("gitPath");
  const gitExtensionPath = vscode.workspace.getConfiguration("git").get<string | string[]>("path");
  return resolveGitBinary({ configuredPath, gitExtensionPath });
}

/**
 * The error to surface when the resolved git binary can't be spawned (ENOENT) — names the PATH
 * problem and the remedy, instead of a bare, unhelpful "git binary not found".
 */
export function gitNotFoundError(): Error {
  return new Error(
    "git not found on PATH or common locations — set `tachyon.gitPath` or `git.path`, or ensure /usr/bin is on the extension host PATH",
  );
}
