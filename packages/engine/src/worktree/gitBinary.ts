/**
 * spec t-e5f75d — resolve the git BINARY to spawn instead of relying on bare `'git'` on the
 * extension host's PATH. A reload with a truncated PATH (no `/usr/bin`) otherwise breaks every
 * git op (worktree create/remove, plugin fetch) with a cryptic ENOENT. Shared by
 * WorktreeManager's `defaultGitExec` and the plugin fetcher's `defaultGitRun`.
 */

import fs from "node:fs";
import type { EngineHost } from "../workspace/EngineHost.js";

/** Common install locations to probe, in order, when nothing is configured. */
const DEFAULT_PROBE_LOCATIONS = ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"];

export interface GitBinaryInputs {
  /** `gitPath` from the global Tachyon settings file, if configured. */
  configuredPath?: string;
  /** the built-in git extension's `git.path` setting — a single path or a list (first entry wins). */
  gitExtensionPath?: string | string[] | null;
  /** common install locations to probe, in order (overridable for tests). */
  probeLocations?: string[];
  /** injectable `fs.existsSync`-alike, for tests. */
  pathExists?: (p: string) => boolean;
}

/**
 * Resolve the git binary to spawn, in order: Tachyon's own `gitPath` > the VS Code git
 * extension's `git.path` > the first common install location that exists on disk > bare `'git'`
 * (PATH). Pure/sync — cheap to call before every spawn, and unit-testable without touching the
 * real fs or a host implementation.
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

/**
 * Resolve Git from Tachyon's own global settings plus the ONE external setting only a shell can see.
 *
 * t-aaad95 — `gitPath` used to arrive through the same generic settings port as `git.path`; it now
 * comes from the global Tachyon file, which the engine reads directly and which answers with no
 * workspace open. The host is asked only for somebody else's key.
 */
export function resolveGitBinaryForHost(host: Pick<EngineHost, "gitExtensionPath">, configuredPath: string): string {
  return resolveGitBinary({ configuredPath, gitExtensionPath: host.gitExtensionPath() });
}

/**
 * The error to surface when the resolved git binary can't be spawned (ENOENT) — names the PATH
 * problem and the remedy, instead of a bare, unhelpful "git binary not found".
 */
export function gitNotFoundError(): Error {
  return new Error(
    "git not found on PATH or common locations — set `gitPath` in Tachyon settings (Control → Settings, or ~/.tachyon/settings.json) or the git extension's `git.path`, or ensure /usr/bin is on the extension host PATH",
  );
}
