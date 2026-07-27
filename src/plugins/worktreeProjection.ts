/**
 * t-36182f — plugin tooling in linked worktrees.
 *
 * A Tachyon worktree is a checkout of the same repository at a different path, and the plugin system
 * is entirely workspace-root-relative: the launcher shim, the materialized skills and the lockfile all
 * live under the root that was installed into. A linked worktree is a DIFFERENT root that nobody
 * installed into, so `.tachyon/bin/_tachyon-tool` and `.claude/skills/<plugin>` are simply absent —
 * and a plugin doctor run from inside one reports the tool as MISSING when it is installed and healthy
 * one directory over. Measured 2026-07-27: `agent-browser` doctor is 16 pass / 0 fail in the primary
 * checkout and `BROWSER_RUNTIME_MISSING` in a fresh worktree.
 *
 * The fix is projection by SYMLINK to the authority checkout, never by copy. Three measured facts make
 * that both sufficient and safe, and each is load-bearing:
 *
 *  1. **The launcher already resolves physically.** The shim does `dir=$(cd "$(dirname "$0")" && pwd -P)`
 *     and the entry then derives the workspace root as `<dir>/../..`. `pwd -P` resolves symlinks, so a
 *     shim reached through a worktree symlink computes the AUTHORITY root — which is exactly where the
 *     lockfile, the pinned binaries and the human-owned confirmation config live. The checksum gate and
 *     the confirmation gate therefore keep working unchanged, against the authority, with no new trust
 *     root and no second copy of the validator.
 *  2. **`.tachyon/bin`, `.claude/skills` and `.agents/skills` are all git-ignored**, so a projection
 *     can never be committed, and `git worktree remove` deletes the LINK rather than following it.
 *  3. **The authority is derivable from git**, not from configuration: `--git-common-dir` for a linked
 *     worktree points into the primary checkout's `.git`, whose parent is the authority root.
 *
 * What is deliberately NOT projected is as important as what is. The lockfile
 * (`.tachyon/plugins.lock.json`), the materialized plugin payloads (`.tachyon/plugins/<name>/…`, which
 * carry the human-owned confirmation config) and every credential-class directory stay in the authority
 * ONLY. The worktree never gets its own copy of a pin, a secret or a gate to drift from — it reaches
 * the authority's through the launcher, or it does not reach it at all.
 */

import fs from "node:fs";
import path from "node:path";
import { isContainedRelPath } from "./paths.js";
import { LOCKFILE_REL_PATH } from "./lockfile.js";

/**
 * The ONLY paths a worktree may project, and the reason each is on the list: it is invoked by a
 * RELATIVE path from the worktree's cwd, and it is read-only tooling.
 *
 * `.tachyon/bin` — `.tachyon/bin/_tachyon-tool <plugin> <tool>` is the documented, and only sanctioned,
 * way to reach a provisioned binary.
 * `.claude/skills` / `.agents/skills` — skills ship scripts invoked as
 * `sh .claude/skills/<plugin>/scripts/<x>.sh` from the workspace root.
 *
 * Adding to this list is a security decision, not a convenience one: see `assertProjectionAllowlist`.
 */
export const PROJECTED_TOOLING_RELS: readonly string[] = [
  ".tachyon/bin",
  ".claude/skills",
  ".agents/skills",
];

/**
 * Path prefixes that may NEVER be projected, because a worktree-local copy of any of them would be a
 * second, drifting source of truth for something the authority owns: the integrity pins, the
 * human-owned confirmation gates, or credential material.
 */
export const NEVER_PROJECT_PREFIXES: readonly string[] = [
  LOCKFILE_REL_PATH,          // the checksum pins — the launcher must read the authority's, always
  ".tachyon/plugins/",        // materialized payloads incl. human-owned confirmation config
  ".tachyon/browser-state",   // credential-class (cookies + tokens)
  ".tachyon/secrets",
  ".tachyon/state",
];

export type ProjectionState =
  /** created the symlink now */
  | "linked"
  /** already the correct symlink — projection is idempotent */
  | "already"
  /** the authority does not have this path: the plugin is genuinely not installed */
  | "absent-in-authority"
  /** the worktree already has real content here; never clobbered */
  | "occupied"
  /** the link could not be created; carries the reason */
  | "failed";

export interface ProjectionEntry {
  rel: string;
  state: ProjectionState;
  /** absolute authority path the link points at, when one exists */
  target?: string;
  reason?: string;
}

export interface ProjectionResult {
  /** absolute authority root the projection resolved to; undefined when this IS the authority */
  authorityRoot?: string;
  entries: ProjectionEntry[];
}

/**
 * Fail closed on a malformed allowlist. This runs on every projection rather than once at module load
 * because the cost of a bad entry is not a crash — it is silently linking a credential or a pin into a
 * worktree, which nothing downstream would flag.
 */
function assertProjectionAllowlist(rels: readonly string[]): void {
  for (const rel of rels) {
    if (!isContainedRelPath(rel)) {
      throw new Error(`worktree projection: '${rel}' is not a contained relative path`);
    }
    for (const denied of NEVER_PROJECT_PREFIXES) {
      if (rel === denied || rel.startsWith(denied) || denied.startsWith(`${rel}/`)) {
        throw new Error(
          `worktree projection: '${rel}' overlaps authority-only state '${denied}' — the authority owns pins, gates and credentials`,
        );
      }
    }
  }
}

/**
 * The checkout that owns the plugin installation, derived from git rather than configured.
 *
 * `gitCommonDirAbs` is `git rev-parse --git-common-dir` resolved to an absolute path: for a linked
 * worktree it is the PRIMARY checkout's `.git`, so its parent is the authority root. Returns undefined
 * when the caller is already the authority (a primary checkout has nothing to project from).
 */
export function resolveAuthorityRoot(worktreeRoot: string, gitCommonDirAbs: string): string | undefined {
  const authority = path.dirname(path.resolve(gitCommonDirAbs));
  const wt = path.resolve(worktreeRoot);
  if (authority === wt) return undefined;
  return authority;
}

/** True when `abs` is a symlink already pointing at `target`. */
function isLinkTo(abs: string, target: string): boolean {
  try {
    if (!fs.lstatSync(abs).isSymbolicLink()) return false;
    return path.resolve(path.dirname(abs), fs.readlinkSync(abs)) === path.resolve(target);
  } catch {
    return false;
  }
}

/**
 * Project the authority's plugin tooling into a linked worktree, by symlink only.
 *
 * Idempotent, and safe to run on every create AND every restart: an existing correct link is left
 * alone, an existing REAL directory is never clobbered (it is reported `occupied`), and a path the
 * authority does not have is reported `absent-in-authority` rather than invented — which is what lets a
 * caller tell "this plugin is not installed" apart from "this plugin is installed but not reachable
 * from here", the distinction the incident turned on.
 */
export function projectPluginTooling(input: {
  worktreeRoot: string;
  authorityRoot: string;
  rels?: readonly string[];
}): ProjectionResult {
  const rels = input.rels ?? PROJECTED_TOOLING_RELS;
  assertProjectionAllowlist(rels);

  const worktreeRoot = path.resolve(input.worktreeRoot);
  const authorityRoot = path.resolve(input.authorityRoot);
  const entries: ProjectionEntry[] = [];

  if (worktreeRoot === authorityRoot) {
    return { entries: rels.map((rel) => ({ rel, state: "already" as const })) };
  }

  for (const rel of rels) {
    const target = path.join(authorityRoot, rel);
    const link = path.join(worktreeRoot, rel);

    if (!fs.existsSync(target)) {
      entries.push({ rel, state: "absent-in-authority" });
      continue;
    }
    if (isLinkTo(link, target)) {
      entries.push({ rel, state: "already", target });
      continue;
    }
    let occupied = false;
    try {
      occupied = fs.lstatSync(link) !== undefined;
    } catch {
      occupied = false;
    }
    if (occupied) {
      // A stale link to somewhere else is ours to fix; real content is not.
      let stale = false;
      try {
        stale = fs.lstatSync(link).isSymbolicLink();
      } catch {
        stale = false;
      }
      if (!stale) {
        entries.push({ rel, state: "occupied", target, reason: `${rel} already exists in the worktree` });
        continue;
      }
      try {
        fs.unlinkSync(link);
      } catch (err) {
        entries.push({ rel, state: "failed", target, reason: `could not replace stale link: ${errText(err)}` });
        continue;
      }
    }

    try {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link);
      entries.push({ rel, state: "linked", target });
    } catch (err) {
      entries.push({ rel, state: "failed", target, reason: errText(err) });
    }
  }

  return { authorityRoot, entries };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A one-line human/agent-facing summary. Its whole job is to keep "not installed" and "installed but
 * not projected here" from reading the same, which is the misdiagnosis that cost a Visual QA pass.
 */
export function describeToolingProjection(result: ProjectionResult): string {
  if (!result.authorityRoot) return "primary checkout — plugin tooling is already local";
  const by = (state: ProjectionState): string[] => result.entries.filter((e) => e.state === state).map((e) => e.rel);
  const parts: string[] = [];
  const linked = [...by("linked"), ...by("already")];
  if (linked.length) parts.push(`projected from ${result.authorityRoot}: ${linked.join(", ")}`);
  const absent = by("absent-in-authority");
  if (absent.length) parts.push(`not installed in the workspace: ${absent.join(", ")}`);
  const occupied = by("occupied");
  if (occupied.length) parts.push(`left as-is (real content present): ${occupied.join(", ")}`);
  const failed = result.entries.filter((e) => e.state === "failed");
  if (failed.length) parts.push(`FAILED: ${failed.map((e) => `${e.rel} (${e.reason})`).join("; ")}`);
  return parts.join(" · ") || "nothing to project";
}
