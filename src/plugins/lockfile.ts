/**
 * spec 250 — the plugin lockfile (`.tachyon/plugins.lock.json`, committed). Records, per installed
 * plugin, exactly what was materialized into each runtime so an update can re-apply and an uninstall
 * can remove PRECISELY what Tachyon wrote — never the user's own edits. Pure parse/serialize; the
 * materialization engine (Step 3) owns the I/O.
 *
 * Fail-closed parse (this is Tachyon-authored, but a corrupted/hand-edited lockfile must not crash an
 * install): returns `{lockfile?, errors}`, never throws.
 */

import type { Runtime } from "./manifest.js";
import { SUPPORTED_RUNTIMES } from "./manifest.js";
import { isContainedRelPath } from "./paths.js";

export const LOCKFILE_REL_PATH = ".tachyon/plugins.lock.json";

/** The kinds of artifact a runtime adapter materializes. v1 (Step 2) implements `settings-hook`;
 *  `skill-dir` and `mcp-server` arrive with the rest of the claude adapter. */
export type TargetKind = "settings-hook" | "skill-dir" | "mcp-server";

const TARGET_KINDS: ReadonlySet<string> = new Set<TargetKind>(["settings-hook", "skill-dir", "mcp-server"]);

/** One thing Tachyon materialized, with enough identity to remove it exactly. */
export interface MaterializedTarget {
  runtime: Runtime;
  kind: TargetKind;
  /** workspace-relative, contained path of the file or dir written/touched. */
  file: string;
  /** a sub-key within `file` for precise removal (e.g. a hook event, an mcp server name). Optional. */
  ref?: string;
  /**
   * Adapter-owned removal identity — OPAQUE to the lockfile, meaningful only to the runtime adapter that
   * wrote it (e.g. the exact claude hook groups Tachyon inserted, for content-based un-merge that survives
   * the user editing the config and never deletes a user's own entry). The lockfile stores it verbatim.
   */
  removal?: unknown;
}

/** Git provenance — enough to re-hydrate the EXACT bytes on a clone (the resolved commit pins it). */
export interface SourceLock {
  type: "git";
  /** the original source-spec the user wrote (e.g. `github:org/repo@v1#path=plugins/foo`). */
  spec: string;
  /** the normalized clone URL. */
  remote: string;
  /** the ref as written (tag / branch / SHA / HEAD). */
  ref: string;
  /** the concrete commit the ref resolved to — the reproducibility pin. */
  resolvedCommit: string;
  /** the `#path=` subdir, when given. */
  subdir?: string;
}

/** Integrity of the materialized payload (NOT the git tree — subdir extraction means the SHA ≠ the bytes). */
export interface IntegrityLock {
  algorithm: "sha256";
  payload: string;
}

export interface PluginLock {
  name: string;
  version: string;
  /** where the plugin came from — provenance for reproducible re-hydrate + audit (absent for a dir install). */
  source?: SourceLock;
  /** integrity hash of the resolved plugin payload (absent for a dir install). */
  integrity?: IntegrityLock;
  /** the runtimes this plugin was actually installed into in THIS workspace. */
  runtimes: Runtime[];
  /** the exact materialization set — the uninstall manifest. */
  targets: MaterializedTarget[];
  /** spec 263 — workspace-relative ancestor dirs THIS install created (did not pre-exist), e.g. `.claude`,
   *  `.agents/skills`. Recorded so uninstall can rmdir exactly what it created (and nothing it didn't).
   *  Optional + additive: an older lock without it parses as none-created (uninstall removes no ancestors). */
  createdAncestors?: string[];
  /** spec 264 — the runtime-agnostic git-hook leaves THIS plugin registered (parallel to `targets`, which
   *  require a runtime). Each is the unambiguous removal identity. Optional + additive (old locks: none). */
  gitHooks?: GitHookLock[];
}

/** One git-hook leaf a plugin registered — the precise removal identity (two plugins with identical leaf
 *  content don't collide: `managedLeafPath` + `ownershipGeneration` disambiguate). */
export interface GitHookLock {
  /** the git event, e.g. `pre-commit` (v1: pre-commit only). */
  event: string;
  /** workspace-relative path of the content-addressed managed leaf (e.g. `.tachyon/githooks/leaves/<hash>`). */
  managedLeafPath: string;
  /** sha256 of the leaf content (= the `leaves/<hash>` name). */
  leafContentHash: string;
  /** the ownership generation at install — guards against unregistering across an unrelated re-claim. */
  ownershipGeneration: number;
}

export interface Lockfile {
  schemaVersion: 1;
  plugins: Record<string, PluginLock>;
}

export function emptyLockfile(): Lockfile {
  return { schemaVersion: 1, plugins: {} };
}

/** Stable, pretty, newline-terminated JSON so the committed lockfile diffs cleanly. */
export function serializeLockfile(lockfile: Lockfile): string {
  return `${JSON.stringify(lockfile, null, 2)}\n`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTarget(raw: unknown, where: string, errors: string[]): MaterializedTarget | null {
  if (!isPlainObject(raw)) {
    errors.push(`${where}: must be an object`);
    return null;
  }
  const runtime = raw.runtime;
  if (typeof runtime !== "string" || !(SUPPORTED_RUNTIMES as readonly string[]).includes(runtime)) {
    errors.push(`${where}.runtime: must be one of ${SUPPORTED_RUNTIMES.join(" | ")}`);
    return null;
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !TARGET_KINDS.has(kind)) {
    errors.push(`${where}.kind: must be one of ${[...TARGET_KINDS].join(" | ")}`);
    return null;
  }
  const file = raw.file;
  if (typeof file !== "string" || !isContainedRelPath(file)) {
    errors.push(`${where}.file: required, a contained workspace-relative path`);
    return null;
  }
  const target: MaterializedTarget = { runtime: runtime as Runtime, kind: kind as TargetKind, file };
  if (raw.ref !== undefined) {
    if (typeof raw.ref !== "string") {
      errors.push(`${where}.ref: must be a string when present`);
      return null;
    }
    target.ref = raw.ref;
  }
  if (raw.removal !== undefined) target.removal = raw.removal; // opaque — the adapter validates its own removal record
  return target;
}

function parseSourceLock(raw: unknown, where: string, errors: string[]): SourceLock | undefined {
  if (!isPlainObject(raw)) { errors.push(`${where}: must be an object`); return undefined; }
  const str = (k: string, required = true): string | undefined => {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (required) errors.push(`${where}.${k}: required string`);
    return undefined;
  };
  if (raw.type !== "git") errors.push(`${where}.type: must be 'git'`);
  const spec = str("spec");
  const remote = str("remote");
  const ref = str("ref");
  const resolvedCommit = raw.resolvedCommit;
  if (typeof resolvedCommit !== "string" || !/^[0-9a-f]{40}$/.test(resolvedCommit)) errors.push(`${where}.resolvedCommit: required 40-hex commit SHA`);
  const subdir = str("subdir", false);
  if (errors.length > 0) return undefined;
  return { type: "git", spec: spec!, remote: remote!, ref: ref!, resolvedCommit: resolvedCommit as string, ...(subdir ? { subdir } : {}) };
}

function parseIntegrityLock(raw: unknown, where: string, errors: string[]): IntegrityLock | undefined {
  if (!isPlainObject(raw)) { errors.push(`${where}: must be an object`); return undefined; }
  if (raw.algorithm !== "sha256") errors.push(`${where}.algorithm: must be 'sha256'`);
  if (typeof raw.payload !== "string" || raw.payload.length === 0) errors.push(`${where}.payload: required string`);
  if (errors.length > 0) return undefined;
  return { algorithm: "sha256", payload: raw.payload as string };
}

function parsePluginLock(key: string, raw: unknown, errors: string[]): PluginLock | null {
  if (!isPlainObject(raw)) {
    errors.push(`plugins.${key}: must be an object`);
    return null;
  }
  const name = raw.name;
  if (typeof name !== "string" || name !== key) {
    errors.push(`plugins.${key}.name: must equal the map key '${key}'`);
    return null;
  }
  const version = raw.version;
  if (typeof version !== "string" || version.length === 0) {
    errors.push(`plugins.${key}.version: required`);
    return null;
  }
  const runtimes: Runtime[] = [];
  const seenRt = new Set<string>();
  // spec 264 — `runtimes` MAY be empty: a git-hook-only plugin is runtime-agnostic and materializes into no
  // runtime. The "≥1 capability" rule is enforced at load/install (via targets/gitHooks), not here.
  if (!Array.isArray(raw.runtimes)) {
    errors.push(`plugins.${key}.runtimes: must be a list`);
  } else {
    for (const r of raw.runtimes) {
      if (typeof r !== "string" || !(SUPPORTED_RUNTIMES as readonly string[]).includes(r)) {
        errors.push(`plugins.${key}.runtimes: '${String(r)}' is not a supported runtime`);
      } else if (seenRt.has(r)) {
        errors.push(`plugins.${key}.runtimes: '${r}' is listed more than once`);
      } else {
        seenRt.add(r);
        runtimes.push(r as Runtime);
      }
    }
  }
  const targets: MaterializedTarget[] = [];
  if (!Array.isArray(raw.targets)) {
    errors.push(`plugins.${key}.targets: required, a list`);
  } else {
    raw.targets.forEach((t, i) => {
      const parsed = parseTarget(t, `plugins.${key}.targets[${i}]`, errors);
      if (parsed) {
        // a target must belong to a runtime this plugin records as installed (no orphan-runtime target).
        if (!seenRt.has(parsed.runtime)) errors.push(`plugins.${key}.targets[${i}].runtime: '${parsed.runtime}' is not in this plugin's runtimes`);
        else targets.push(parsed);
      }
    });
  }
  // optional provenance structs, when present, must be well-typed (a malformed value is corruption, not ignorable).
  const source = raw.source === undefined ? undefined : parseSourceLock(raw.source, `plugins.${key}.source`, errors);
  const integrity = raw.integrity === undefined ? undefined : parseIntegrityLock(raw.integrity, `plugins.${key}.integrity`, errors);

  // spec 263 — optional installer-created ancestors: contained relative paths, deduped (additive; absent = none).
  let createdAncestors: string[] | undefined;
  if (raw.createdAncestors !== undefined) {
    if (!Array.isArray(raw.createdAncestors)) {
      errors.push(`plugins.${key}.createdAncestors: must be a list when present`);
    } else {
      const seen = new Set<string>();
      const acc: string[] = [];
      raw.createdAncestors.forEach((p, i) => {
        if (typeof p !== "string" || !isContainedRelPath(p)) {
          errors.push(`plugins.${key}.createdAncestors[${i}]: must be a contained workspace-relative path`);
        } else if (!seen.has(p)) {
          seen.add(p);
          acc.push(p);
        }
      });
      createdAncestors = acc;
    }
  }

  // spec 264 — optional git-hook leaves (parallel to targets; runtime-agnostic). Fail-closed shape.
  let gitHooks: GitHookLock[] | undefined;
  if (raw.gitHooks !== undefined) {
    if (!Array.isArray(raw.gitHooks)) {
      errors.push(`plugins.${key}.gitHooks: must be a list when present`);
    } else {
      const acc: GitHookLock[] = [];
      raw.gitHooks.forEach((g, i) => {
        const where = `plugins.${key}.gitHooks[${i}]`;
        if (!isPlainObject(g)) { errors.push(`${where}: must be an object`); return; }
        if (typeof g.event !== "string" || g.event.length === 0) { errors.push(`${where}.event: required string`); return; }
        if (typeof g.managedLeafPath !== "string" || !isContainedRelPath(g.managedLeafPath)) { errors.push(`${where}.managedLeafPath: must be a contained workspace-relative path`); return; }
        if (typeof g.leafContentHash !== "string" || !/^[0-9a-f]{64}$/.test(g.leafContentHash)) { errors.push(`${where}.leafContentHash: required 64-hex sha256`); return; }
        if (typeof g.ownershipGeneration !== "number" || !Number.isInteger(g.ownershipGeneration)) { errors.push(`${where}.ownershipGeneration: required integer`); return; }
        acc.push({ event: g.event, managedLeafPath: g.managedLeafPath, leafContentHash: g.leafContentHash, ownershipGeneration: g.ownershipGeneration });
      });
      gitHooks = acc;
    }
  }

  if (errors.length > 0) return null;

  const lock: PluginLock = { name, version, runtimes, targets };
  if (source) lock.source = source;
  if (integrity) lock.integrity = integrity;
  if (createdAncestors && createdAncestors.length > 0) lock.createdAncestors = createdAncestors;
  if (gitHooks && gitHooks.length > 0) lock.gitHooks = gitHooks;
  return lock;
}

export interface LockfileParseResult {
  lockfile?: Lockfile;
  errors: string[];
}

/** Parse + validate a lockfile from raw JSON text. Fail-closed; never throws. */
export function parseLockfile(rawJson: string): LockfileParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!isPlainObject(parsed)) return { errors: ["lockfile: must be a JSON object"] };
  if (parsed.schemaVersion !== 1) return { errors: ["lockfile.schemaVersion: must be 1"] };
  if (!isPlainObject(parsed.plugins)) return { errors: ["lockfile.plugins: must be an object"] };

  const errors: string[] = [];
  const plugins: Record<string, PluginLock> = Object.create(null);
  for (const [key, raw] of Object.entries(parsed.plugins)) {
    const lock = parsePluginLock(key, raw, errors);
    if (lock) plugins[key] = lock;
  }
  if (errors.length > 0) return { errors };

  return { lockfile: { schemaVersion: 1, plugins: { ...plugins } }, errors: [] };
}
