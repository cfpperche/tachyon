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
 * way to reach a provisioned binary. It is INERT: nothing discovers it, nothing loads it into a
 * session; something has to name it. That is why it stays while the skill trees left.
 *
 * Adding to this list is a security decision, not a convenience one: see `assertProjectionAllowlist`.
 */
export const PROJECTED_TOOLING_RELS: readonly string[] = [
  ".tachyon/bin",
];

/**
 * t-62f599 — the two paths this projection used to include, and why they had to stop.
 *
 * Maintainer's ruling, 2026-07-31: an agent given its own worktree that did not explicitly ask to
 * inherit the workspace's configuration must not have it, no matter that the workspace or the global
 * config holds it. Inheritance is opt-in; silence means no.
 *
 * A projected skill tree broke that, and did it INVISIBLY. Measured on this workspace: the codex agent
 * had all twelve workspace plugin skills on offer — including two that spend real money through
 * fal.ai — under a profile that granted none of them. The Claude agents happened to be spared only
 * because `--setting-sources user` closes the `project` setting source, which is a flag Codex has no
 * equivalent of. So the policy existed in one runtime and was unenforceable in the other.
 *
 * Withdrawing the projection is what makes the rule hold the same way everywhere, through the one
 * mechanism every runtime shares: the working directory. What arrives at an agent stops depending on
 * which runtime it happens to be.
 *
 * These stay listed rather than being deleted, because a worktree created by an earlier build already
 * HAS the links. An allowlist alone would leave every existing worktree open — the door would be shut
 * only for agents nobody had created yet.
 */
export const RETIRED_PROJECTION_RELS: readonly string[] = [
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
  /** t-62f599 — a link from a build that still projected this path, removed now */
  | "retired"
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

  // t-62f599 — withdraw what earlier builds projected, BEFORE linking anything new. This runs on every
  // worktree registration and every restart, which is what turns the policy change into a fact on disk
  // for worktrees that already exist rather than a promise about future ones.
  entries.push(...retireProjections(worktreeRoot, authorityRoot));

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

/**
 * t-62f599 — remove a retired projection, and ONLY when it is one we made.
 *
 * The test is deliberately narrow: a symlink whose target is the authority's copy of that same path.
 * Real content in the worktree is somebody's work and is never touched, and a symlink pointing
 * anywhere else was not ours to place or to remove. Getting this wrong would mean deleting a human's
 * hand-written skills to enforce a policy about inheritance, which is the opposite of the point.
 *
 * A failure is reported, never thrown: a worktree whose stale link could not be removed is still a
 * valid worktree, and the caller's own contract is best-effort. But it must not be silent — an
 * unremoved link means an agent still has the inheritance this ruling withdrew.
 */
function retireProjections(worktreeRoot: string, authorityRoot: string): ProjectionEntry[] {
  const entries: ProjectionEntry[] = [];
  for (const rel of RETIRED_PROJECTION_RELS) {
    const link = path.join(worktreeRoot, rel);
    const target = path.join(authorityRoot, rel);
    if (!isLinkTo(link, target)) continue;
    try {
      fs.unlinkSync(link);
      entries.push({ rel, state: "retired", target });
    } catch (err) {
      entries.push({ rel, state: "failed", target, reason: `could not retire projection: ${errText(err)}` });
    }
  }
  return entries;
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
  // t-62f599 — say it out loud. An agent losing inherited skills mid-life is exactly the kind of
  // change that reads as a bug when it happens without a word.
  const retired = by("retired");
  if (retired.length) parts.push(`withdrew inherited workspace config (agents inherit only what their profile grants): ${retired.join(", ")}`);
  const absent = by("absent-in-authority");
  if (absent.length) parts.push(`not installed in the workspace: ${absent.join(", ")}`);
  const occupied = by("occupied");
  if (occupied.length) parts.push(`left as-is (real content present): ${occupied.join(", ")}`);
  const failed = result.entries.filter((e) => e.state === "failed");
  if (failed.length) parts.push(`FAILED: ${failed.map((e) => `${e.rel} (${e.reason})`).join("; ")}`);
  return parts.join(" · ") || "nothing to project";
}
