/**
 * spec 250 — the plugin lockfile (`.tachyon/plugins.lock.json`, committed). Records, per installed
 * plugin, exactly what was materialized into each runtime so an update can re-apply and an uninstall
 * can remove PRECISELY what Tachyon wrote — never the user's own edits. Pure parse/serialize; the
 * materialization engine (Step 3) owns the I/O.
 *
 * Fail-closed parse (this is Tachyon-authored, but a corrupted/hand-edited lockfile must not crash an
 * install): returns `{lockfile?, errors}`, never throws.
 */

import path from "node:path";
import type { Runtime, ToolLaunchPolicy } from "./manifest.js";
import { SUPPORTED_RUNTIMES, TOOL_PLATFORM_KEYS, parseLaunchPolicy } from "./manifest.js";
import { isContainedRelPath } from "./paths.js";

export const LOCKFILE_REL_PATH = ".tachyon/plugins.lock.json";

const SHA256_RE = /^[0-9a-f]{64}$/;
const TOOL_PLATFORM_KEY_SET: ReadonlySet<string> = new Set(TOOL_PLATFORM_KEYS);

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
  /** spec 265 — the provisioned tools THIS plugin installed (full provenance for byte-reproducible
   *  re-hydrate + physical-identity refcount). Optional + additive (old locks: none). */
  tools?: ToolLock[];
  /** spec 270 — the human-facing config this plugin ships: workspace-relative config file (+ optional schema
   *  file) the card's Config button opens. Optional + additive (old locks: none). */
  config?: { file: string; schemaFile?: string };
  /** spec 270 — the plugin's https docs URL, surfaced as the card's Docs button. Optional + additive. */
  docsUrl?: string;
}

/** One provisioned tool's full provenance — enough to re-hydrate the exact bytes and to refcount/dedup by
 *  PHYSICAL identity (installPath + binSha256) across plugins (spec 265, H7). */
export interface ToolLock {
  name: string;
  /** `fetched` (downloaded + content-addressed) or `host-provided` (a trusted host binary, never deleted). */
  source: "fetched" | "host-provided";
  /** the resolved platform key this artifact was provisioned for. */
  resolvedPlatform: string;
  /** the pinned version label (surfaced at consent; not parsed as semver). */
  version: string;
  /** the EXECUTABLE bytes' sha256 — the install identity + the runtime pin the launcher re-validates. */
  binSha256: string;
  /** the on-disk leaf filename. */
  exeName: string;
  /** fetched: the content-addressed workspace-relative path; host-provided: the absolute real host path. */
  installPath: string;
  /** fetched only — the manifest-declared download URL. */
  declaredUrl?: string;
  /** fetched only — the redirect-resolved final URL actually fetched (consent↔fetch binding). */
  finalUrl?: string;
  /** fetched only — the downloaded artifact's sha256 (separate from binSha256 for an archive). */
  artifactSha256?: string;
  /** fetched-archive only — the extracted member path within the artifact. */
  archive?: { innerPath: string };
  /** host-provided only — the detected host binary (real path + version output + hash at consent time). */
  hostDetected?: { path: string; version: string; hash: string };
  /** host-provided only — the optional manifest gate recorded at install. */
  allowedHostSha256?: string;
  /** spec 269 — the consented launcher-enforced launch policy (the launcher reads it from HERE, not the manifest). */
  launchPolicy?: ToolLaunchPolicy;
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

/** Validate an https URL string (lockfile provenance). */
function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse one tool provenance record. Fail-closed: a malformed value is corruption, not ignorable. */
function parseToolLock(raw: unknown, where: string, errors: string[]): ToolLock | null {
  if (!isPlainObject(raw)) {
    errors.push(`${where}: must be an object`);
    return null;
  }
  const str = (k: string): string | null => (typeof raw[k] === "string" && (raw[k] as string).length > 0 ? (raw[k] as string) : null);
  const name = str("name");
  if (!name) errors.push(`${where}.name: required`);
  const source = raw.source;
  if (source !== "fetched" && source !== "host-provided") errors.push(`${where}.source: must be 'fetched' or 'host-provided'`);
  const resolvedPlatform = str("resolvedPlatform");
  if (!resolvedPlatform || !TOOL_PLATFORM_KEY_SET.has(resolvedPlatform)) errors.push(`${where}.resolvedPlatform: must be a known platform key`);
  const version = str("version");
  if (!version) errors.push(`${where}.version: required`);
  const binSha256 = str("binSha256");
  if (!binSha256 || !SHA256_RE.test(binSha256)) errors.push(`${where}.binSha256: required 64-hex sha256`);
  const exeName = str("exeName");
  if (!exeName || exeName.includes("/") || exeName === "." || exeName === "..") errors.push(`${where}.exeName: required leaf filename (no '/')`);
  const installPath = str("installPath");
  if (!installPath) {
    errors.push(`${where}.installPath: required`);
  } else if (source === "fetched" && !isContainedRelPath(installPath)) {
    errors.push(`${where}.installPath: a fetched tool must be a contained workspace-relative path`);
  } else if (source === "host-provided" && !path.isAbsolute(installPath)) {
    errors.push(`${where}.installPath: a host-provided tool must be an absolute path`);
  }

  if (source === "fetched") {
    if (!isHttpsUrl(raw.declaredUrl)) errors.push(`${where}.declaredUrl: required https URL for a fetched tool`);
    if (!isHttpsUrl(raw.finalUrl)) errors.push(`${where}.finalUrl: required https URL for a fetched tool`);
    if (typeof raw.artifactSha256 !== "string" || !SHA256_RE.test(raw.artifactSha256)) errors.push(`${where}.artifactSha256: required 64-hex for a fetched tool`);
    if (raw.archive !== undefined) {
      if (!isPlainObject(raw.archive) || typeof raw.archive.innerPath !== "string" || !isContainedRelPath(raw.archive.innerPath)) {
        errors.push(`${where}.archive.innerPath: must be a contained relative path`);
      }
    }
  }
  if (source === "host-provided") {
    const hd = raw.hostDetected;
    if (!isPlainObject(hd) || typeof hd.path !== "string" || !path.isAbsolute(hd.path) || typeof hd.version !== "string" || typeof hd.hash !== "string" || !SHA256_RE.test(hd.hash)) {
      errors.push(`${where}.hostDetected: required { path (absolute), version, hash (64-hex) } for a host-provided tool`);
    }
    if (raw.allowedHostSha256 !== undefined && (typeof raw.allowedHostSha256 !== "string" || !SHA256_RE.test(raw.allowedHostSha256))) {
      errors.push(`${where}.allowedHostSha256: must be a 64-hex sha256 when present`);
    }
  }

  // spec 269 — re-validate the consented launch policy with the manifest's own rules (fail-closed: a corrupt
  // policy refuses the whole lock rather than launching the tool unpoliced).
  let launchPolicy: ToolLaunchPolicy | undefined;
  if (raw.launchPolicy !== undefined) launchPolicy = parseLaunchPolicy(`${where}.launchPolicy`, raw.launchPolicy, errors) ?? undefined;

  if (errors.length > 0) return null;
  const lock: ToolLock = {
    name: name as string,
    source: source as "fetched" | "host-provided",
    resolvedPlatform: resolvedPlatform as string,
    version: version as string,
    binSha256: binSha256 as string,
    exeName: exeName as string,
    installPath: installPath as string,
    ...(launchPolicy ? { launchPolicy } : {}),
  };
  if (source === "fetched") {
    lock.declaredUrl = raw.declaredUrl as string;
    lock.finalUrl = raw.finalUrl as string;
    lock.artifactSha256 = raw.artifactSha256 as string;
    if (isPlainObject(raw.archive)) lock.archive = { innerPath: raw.archive.innerPath as string };
  } else {
    const hd = raw.hostDetected as Record<string, unknown>;
    lock.hostDetected = { path: hd.path as string, version: hd.version as string, hash: hd.hash as string };
    if (typeof raw.allowedHostSha256 === "string") lock.allowedHostSha256 = raw.allowedHostSha256;
  }
  return lock;
}

/** The PHYSICAL identity of a tool's executable bytes (H7): same bytes at the same path = one ref target,
 *  regardless of the logical tool/plugin name. Removal deletes a content-addressed file only when its last
 *  physical referrer is gone. */
export function physicalToolKey(t: ToolLock): string {
  return `${t.installPath} ${t.binSha256}`;
}

/** Map each physical tool identity → the set of plugin names that reference it across the whole lockfile. */
export function toolReferenceCounts(lockfile: Lockfile): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  for (const [pluginName, lock] of Object.entries(lockfile.plugins)) {
    for (const t of lock.tools ?? []) {
      const key = physicalToolKey(t);
      let set = refs.get(key);
      if (!set) {
        set = new Set();
        refs.set(key, set);
      }
      set.add(pluginName);
    }
  }
  return refs;
}

/** spec 265 — the workspace-level launcher integrity record (codex task-10 review C). The launcher is global
 *  (one per workspace, not per plugin); its integrity lives HERE, not only in mutable `.tachyon/bin`. `nodePath`
 *  is the absolute trust-checked Node baked into the shim — re-resolved on rehydrate (clone/CI can't trust it). */
export interface LauncherLock {
  nodePath: string;
  shimSha256: string;
  validatorSha256: string;
}

export interface Lockfile {
  schemaVersion: 1;
  plugins: Record<string, PluginLock>;
  /** present once any plugin provisions tools; removed when the last tool-bearing plugin is uninstalled. */
  launcher?: LauncherLock;
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

  // spec 265 — optional provisioned tools (parallel to targets/gitHooks). Fail-closed shape.
  let tools: ToolLock[] | undefined;
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) {
      errors.push(`plugins.${key}.tools: must be a list when present`);
    } else {
      const acc: ToolLock[] = [];
      raw.tools.forEach((t, i) => {
        const parsed = parseToolLock(t, `plugins.${key}.tools[${i}]`, errors);
        if (parsed) acc.push(parsed);
      });
      tools = acc;
    }
  }

  // spec 270 — optional human-facing config descriptor + docs URL (additive; old locks: none). Fail-closed.
  let config: { file: string; schemaFile?: string } | undefined;
  if (raw.config !== undefined) {
    const where = `plugins.${key}.config`;
    if (!isPlainObject(raw.config) || typeof raw.config.file !== "string" || !isContainedRelPath(raw.config.file)) {
      errors.push(`${where}.file: must be a contained workspace-relative path`);
    } else if (raw.config.schemaFile !== undefined && (typeof raw.config.schemaFile !== "string" || !isContainedRelPath(raw.config.schemaFile))) {
      errors.push(`${where}.schemaFile: must be a contained workspace-relative path when present`);
    } else {
      config = { file: raw.config.file, ...(typeof raw.config.schemaFile === "string" ? { schemaFile: raw.config.schemaFile } : {}) };
    }
  }
  let docsUrl: string | undefined;
  if (raw.docsUrl !== undefined) {
    if (!isHttpsUrl(raw.docsUrl)) errors.push(`plugins.${key}.docsUrl: must be an https URL when present`);
    else docsUrl = raw.docsUrl;
  }

  if (errors.length > 0) return null;

  const lock: PluginLock = { name, version, runtimes, targets };
  if (source) lock.source = source;
  if (integrity) lock.integrity = integrity;
  if (createdAncestors && createdAncestors.length > 0) lock.createdAncestors = createdAncestors;
  if (gitHooks && gitHooks.length > 0) lock.gitHooks = gitHooks;
  if (tools && tools.length > 0) lock.tools = tools;
  if (config) lock.config = config;
  if (docsUrl) lock.docsUrl = docsUrl;
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

  // spec 265 — optional workspace-level launcher record (additive; absent on a pre-265 / tool-less lockfile).
  let launcher: LauncherLock | undefined;
  if (parsed.launcher !== undefined) {
    const l = parsed.launcher;
    if (!isPlainObject(l) || typeof l.nodePath !== "string" || !path.isAbsolute(l.nodePath) || typeof l.shimSha256 !== "string" || !SHA256_RE.test(l.shimSha256) || typeof l.validatorSha256 !== "string" || !SHA256_RE.test(l.validatorSha256)) {
      errors.push("lockfile.launcher: must be { nodePath (absolute), shimSha256 (64-hex), validatorSha256 (64-hex) }");
    } else {
      launcher = { nodePath: l.nodePath, shimSha256: l.shimSha256, validatorSha256: l.validatorSha256 };
    }
  }

  if (errors.length > 0) return { errors };

  return { lockfile: { schemaVersion: 1, plugins: { ...plugins }, ...(launcher ? { launcher } : {}) }, errors: [] };
}
