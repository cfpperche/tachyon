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

export interface PluginLock {
  name: string;
  version: string;
  /** where the plugin came from (marketplace ref / git url / path) — provenance for re-hydrate + audit. */
  source?: string;
  /** integrity hash of the resolved plugin payload. */
  integrity?: string;
  /** the runtimes this plugin was actually installed into in THIS workspace. */
  runtimes: Runtime[];
  /** the exact materialization set — the uninstall manifest. */
  targets: MaterializedTarget[];
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
  if (!Array.isArray(raw.runtimes) || raw.runtimes.length === 0) {
    errors.push(`plugins.${key}.runtimes: required, a non-empty list`);
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
  // optional fields, when present, must be well-typed (a malformed value is a corruption signal, not ignorable).
  let source: string | undefined;
  if (raw.source !== undefined) {
    if (typeof raw.source !== "string") errors.push(`plugins.${key}.source: must be a string when present`);
    else source = raw.source;
  }
  let integrity: string | undefined;
  if (raw.integrity !== undefined) {
    if (typeof raw.integrity !== "string") errors.push(`plugins.${key}.integrity: must be a string when present`);
    else integrity = raw.integrity;
  }
  if (errors.length > 0) return null;

  const lock: PluginLock = { name, version, runtimes, targets };
  if (source !== undefined) lock.source = source;
  if (integrity !== undefined) lock.integrity = integrity;
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
