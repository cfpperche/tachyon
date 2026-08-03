/**
 * t-09be02 — "did TACHYON put this here?", answered from the plugin lockfile and the bytes on disk.
 *
 * The canonical-profile inspector refuses a runtime's PROJECT-level input paths so an agent cannot
 * silently inherit configuration nobody declared for it. The plugin engine writes into those same
 * paths (`.grok/skills/<skill>`, `.grok/hooks/tachyon-plugins.json`), so installing ANY plugin made a
 * canonical Grok agent impossible to create. Both sides were right on their own; the QUESTION was
 * wrong. "Does anything exist under `.grok/skills`?" answers *is this workspace pristine*, not *is
 * there anything here the product did not put there* — and only the second one is the inheritance
 * invariant ("silence means DO NOT inherit"). A skill the plugin engine installed is not silence: it
 * was declared, consented at install, and recorded with a receipt.
 *
 * So this module answers the second question. `.tachyon/plugins.lock.json` records every path the
 * engine materialized, per runtime, and the payload it copied from is still on disk under
 * `.tachyon/plugins/<plugin>/`. A claimed path counts as a PROJECTION only while its bytes still match
 * that receipt. Everything else — an entry no plugin claims, a claimed path whose content drifted, a
 * kind that cannot be verified from a receipt — is AMBIENT and keeps blocking.
 *
 * Subtracting by path NAME alone would be trivially defeated: `mkdir .grok/skills/sdd` would walk
 * straight through the lock. The comparison is therefore by CONTENT, against the payload the installer
 * copies from — the only receipt that survives a hand edit. (The lockfile's `integrity.payload` hashes
 * the plugin payload as FETCHED, which spec 270 deliberately lets drift once a human edits the
 * plugin's config file, so it cannot be the per-target receipt; the installed payload tree can, because
 * `activateInstall` copies each skill dir from it verbatim.)
 *
 * Fail-closed throughout: an unparseable or absent lockfile claims NOTHING, a missing payload proves
 * nothing, a symlink is never a projection, and an unverifiable claim is ambient rather than assumed
 * fine. The failure this module must never allow is a false "projected".
 */

import fs from "node:fs";
import path from "node:path";
import type { Runtime } from "./manifest.js";
import { LOCKFILE_REL_PATH, parseLockfile, type TargetKind } from "./lockfile.js";
import { PLUGIN_PAYLOAD_ROOT, PLUGIN_SKILLS_DIR, isContainedRelPath } from "./paths.js";

/** Same shape as the payload preflight caps: a comparison must never become an unbounded walk. */
const MAX_COMPARE_DEPTH = 32;
const MAX_COMPARE_FILES = 5000;
const MAX_COMPARE_BYTES = 50 * 1024 * 1024; // 50 MB

/** One lockfile claim over a workspace path: which plugin wrote it, as what, with which removal record. */
interface ProjectionClaim {
  plugin: string;
  kind: TargetKind;
  /** the target's sub-key (a hook event, an mcp server name) when it has one. */
  ref?: string;
  /** the adapter-owned removal identity recorded at install — the receipt for a merged settings file. */
  removal?: unknown;
}

/** Every path one runtime's installed plugins claim in this workspace, plus their ancestor directories. */
export interface RuntimeProjectionClaims {
  runtime: Runtime;
  /** workspace-relative posix path → the claims recorded over it (a settings file carries one per event). */
  byPath: ReadonlyMap<string, readonly ProjectionClaim[]>;
  /** every strict ancestor directory of a claimed path (`.grok`, `.grok/skills`, …). */
  ancestors: ReadonlySet<string>;
}

const EMPTY_CLAIMS = (runtime: Runtime): RuntimeProjectionClaims => ({ runtime, byPath: new Map(), ancestors: new Set() });

/**
 * Read what the plugin lockfile claims THIS runtime materialized into the workspace. A missing lockfile
 * (no plugins) and a corrupt one both claim nothing — the caller then treats every present path as
 * ambient, which is the pre-t-09be02 behavior and the safe direction to fail.
 */
export function readRuntimeProjectionClaims(workspaceRoot: string, runtime: Runtime): RuntimeProjectionClaims {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceRoot, ...LOCKFILE_REL_PATH.split("/")), "utf8");
  } catch {
    return EMPTY_CLAIMS(runtime);
  }
  const parsed = parseLockfile(raw);
  if (!parsed.lockfile) return EMPTY_CLAIMS(runtime);

  const byPath = new Map<string, ProjectionClaim[]>();
  const ancestors = new Set<string>();
  for (const [pluginName, lock] of Object.entries(parsed.lockfile.plugins)) {
    for (const target of lock.targets) {
      if (target.runtime !== runtime) continue; // `view` targets carry no runtime and live under the payload root
      if (!isContainedRelPath(target.file)) continue; // parseLockfile already refuses these; belt and braces
      const claims = byPath.get(target.file) ?? [];
      claims.push({ plugin: pluginName, kind: target.kind, ...(target.ref !== undefined ? { ref: target.ref } : {}), ...(target.removal !== undefined ? { removal: target.removal } : {}) });
      byPath.set(target.file, claims);
      for (let dir = path.posix.dirname(target.file); dir && dir !== "." && dir !== "/"; dir = path.posix.dirname(dir)) ancestors.add(dir);
    }
  }
  return { runtime, byPath, ancestors };
}

/** What an inspected workspace path turned out to be. `ambient` and `unreadable` both name the OFFENDING path,
 *  which is a descendant of the inspected candidate when the candidate is a directory. */
export type ProjectedInputVerdict =
  | { status: "absent" }
  /** the path exists and every byte under it is accounted for by a verified receipt. */
  | { status: "projected" }
  /** the path exists and something under it is NOT Tachyon's projection — the inheritance invariant still bites. */
  | { status: "ambient"; path: string; detail?: string }
  /** the path could not be inspected safely; the caller must refuse rather than guess. */
  | { status: "unreadable"; path: string; detail: string };

/**
 * Classify one workspace-relative candidate path (e.g. `.grok/skills`) as absent, a verified Tachyon
 * projection, or ambient input.
 *
 * A DIRECTORY that is merely an ancestor of claimed paths is descended into: `.grok/skills` is not
 * itself a target, so it is projection only while every entry inside it is. That is what keeps a
 * hand-written `.grok/skills/mine` blocking while `.grok/skills/sdd` does not.
 */
export function inspectRuntimeWorkspaceInput(
  workspaceRoot: string,
  claims: RuntimeProjectionClaims,
  relPath: string,
): ProjectedInputVerdict {
  return inspect(workspaceRoot, claims, relPath, 0);
}

function inspect(workspaceRoot: string, claims: RuntimeProjectionClaims, rel: string, depth: number): ProjectedInputVerdict {
  if (depth > MAX_COMPARE_DEPTH) return { status: "ambient", path: rel, detail: "nested deeper than a plugin payload can be" };
  const absolute = path.join(workspaceRoot, ...rel.split("/"));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent" };
    return { status: "unreadable", path: rel, detail: code ?? "read error" };
  }

  const claimed = claims.byPath.get(rel);
  if (claimed && claimed.length > 0) {
    const mismatch = verifyClaimedPath(workspaceRoot, absolute, rel, claimed, stat);
    return mismatch ? { status: "ambient", path: rel, detail: mismatch } : { status: "projected" };
  }

  // Not itself a target. Only a real directory that ANY claim sits under may be descended into; a symlink
  // standing where a claimed ancestor should be is ambient by construction (the engine never creates one).
  if (stat.isDirectory() && claims.ancestors.has(rel)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      return { status: "unreadable", path: rel, detail: (error as NodeJS.ErrnoException).code ?? "read error" };
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const verdict = inspect(workspaceRoot, claims, path.posix.join(rel, entry.name), depth + 1);
      if (verdict.status !== "projected" && verdict.status !== "absent") return verdict;
    }
    return { status: "projected" };
  }

  return { status: "ambient", path: rel };
}

/** Verify a claimed path against its receipt. Returns a reason when it is NOT a faithful projection. */
function verifyClaimedPath(
  workspaceRoot: string,
  absolute: string,
  rel: string,
  claims: readonly ProjectionClaim[],
  stat: fs.Stats,
): string | undefined {
  const kinds = new Set(claims.map((c) => c.kind));
  if (kinds.size !== 1) return `conflicting lockfile claims (${[...kinds].sort().join(", ")})`;
  const kind = claims[0]!.kind;

  if (kind === "skill-dir") {
    if (claims.length !== 1) return `claimed as a skill by more than one plugin (${claims.map((c) => c.plugin).sort().join(", ")})`;
    const plugin = claims[0]!.plugin;
    if (!stat.isDirectory()) return `claimed by plugin '${plugin}' as a skill directory but is not a directory`;
    const leaf = path.posix.basename(rel);
    const sourceRel = path.posix.join(PLUGIN_PAYLOAD_ROOT, plugin, PLUGIN_SKILLS_DIR, leaf);
    if (!isContainedRelPath(sourceRel)) return `claimed by plugin '${plugin}' but its payload path is not a safe workspace path`;
    const source = path.join(workspaceRoot, ...sourceRel.split("/"));
    let sourceStat: fs.Stats;
    try {
      sourceStat = fs.lstatSync(source);
    } catch {
      return `claimed by plugin '${plugin}' but its installed payload ${sourceRel} is missing, so the content cannot be proven`;
    }
    if (!sourceStat.isDirectory()) return `claimed by plugin '${plugin}' but its installed payload ${sourceRel} is not a directory`;
    const budget = { files: 0, bytes: 0 };
    const difference = compareTrees(absolute, source, 0, budget);
    return difference ? `claimed by plugin '${plugin}' but its content does not match the installed payload (${difference})` : undefined;
  }

  if (kind === "settings-hook") {
    if (!stat.isFile()) return "claimed as a plugin hook file but is not a regular file";
    return verifyOwnedHookFile(absolute, claims);
  }

  // `mcp-server` merges into a config file that also carries the person's OWN servers, and `view` targets
  // never live under a runtime's input dir at all. Neither has a receipt that proves the WHOLE file is
  // Tachyon's, so neither can clear a path for the inheritance invariant.
  return `claimed as '${kind}', which carries no receipt for the whole file`;
}

/**
 * A hook file Tachyon owns is projection only when EVERY group in it is one the lockfile recorded for
 * that file (count-aware, key-order independent). A user's own group added to the same file, or an
 * unrelated top-level key, means the file is no longer only ours — which is exactly the ambient input
 * the invariant refuses.
 */
function verifyOwnedHookFile(absolute: string, claims: readonly ProjectionClaim[]): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    return `cannot be read (${(error as NodeJS.ErrnoException).code ?? "read error"})`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "is not valid JSON, so what it carries cannot be proven";
  }
  if (!isPlainObject(parsed)) return "is not a JSON object";
  const extraKeys = Object.keys(parsed).filter((k) => k !== "hooks");
  if (extraKeys.length > 0) return `carries non-plugin keys (${extraKeys.sort().join(", ")})`;
  const hooks = parsed.hooks;
  if (hooks === undefined) return undefined; // `{}` — nothing to inherit
  if (!isPlainObject(hooks)) return "'hooks' is not an object";

  // the receipt: the exact groups recorded per event, as a multiset of canonical forms.
  const recorded = new Map<string, Map<string, number>>();
  for (const claim of claims) {
    if (typeof claim.ref !== "string") return "a recorded hook target carries no event";
    if (!Array.isArray(claim.removal)) return `plugin '${claim.plugin}' recorded no removable groups for ${claim.ref}`;
    const perEvent = recorded.get(claim.ref) ?? new Map<string, number>();
    for (const group of claim.removal) {
      const key = canon(group);
      perEvent.set(key, (perEvent.get(key) ?? 0) + 1);
    }
    recorded.set(claim.ref, perEvent);
  }

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return `hooks.${event} is not a list`;
    const perEvent = recorded.get(event);
    if (!perEvent) return `carries a '${event}' hook no plugin installed`;
    const remaining = new Map(perEvent);
    for (const group of groups) {
      const key = canon(group);
      const left = remaining.get(key) ?? 0;
      if (left <= 0) return `carries a '${event}' hook group Tachyon did not install`;
      remaining.set(key, left - 1);
    }
  }
  return undefined;
}

/**
 * Byte-exact tree comparison between a materialized target and the payload it was copied from. Same
 * entry names, same kinds, same bytes — nothing else counts as the same tree. Symlinks and special
 * files are a difference on either side: `activateInstall` copies with `dereference:false` from a
 * payload that already refuses symlinks, so one appearing here is a hand edit.
 */
function compareTrees(projected: string, source: string, depth: number, budget: { files: number; bytes: number }): string | undefined {
  if (depth > MAX_COMPARE_DEPTH) return "nested deeper than a plugin payload can be";
  let here: fs.Dirent[];
  let there: fs.Dirent[];
  try {
    here = fs.readdirSync(projected, { withFileTypes: true });
    there = fs.readdirSync(source, { withFileTypes: true });
  } catch (error) {
    return `cannot be compared (${(error as NodeJS.ErrnoException).code ?? "read error"})`;
  }
  const sourceByName = new Map(there.map((e) => [e.name, e]));
  for (const entry of here.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const twin = sourceByName.get(entry.name);
    if (!twin) return `extra entry '${entry.name}'`;
    sourceByName.delete(entry.name);
    const a = path.join(projected, entry.name);
    const b = path.join(source, entry.name);
    if (entry.isSymbolicLink() || twin.isSymbolicLink()) return `symlink '${entry.name}'`;
    if (entry.isDirectory() !== twin.isDirectory()) return `entry '${entry.name}' changed kind`;
    if (entry.isDirectory()) {
      const nested = compareTrees(a, b, depth + 1, budget);
      if (nested) return nested;
      continue;
    }
    if (!entry.isFile() || !twin.isFile()) return `special file '${entry.name}'`;
    if (++budget.files > MAX_COMPARE_FILES) return "exceeds the comparable file count";
    let left: Buffer;
    let right: Buffer;
    try {
      const size = fs.statSync(a).size;
      budget.bytes += size;
      if (budget.bytes > MAX_COMPARE_BYTES) return "exceeds the comparable byte budget";
      left = fs.readFileSync(a);
      right = fs.readFileSync(b);
    } catch (error) {
      return `cannot be compared (${(error as NodeJS.ErrnoException).code ?? "read error"})`;
    }
    if (!left.equals(right)) return `content of '${entry.name}' differs`;
  }
  const missing = [...sourceByName.keys()].sort()[0];
  return missing === undefined ? undefined : `missing entry '${missing}'`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Key-sorted canonical serialization, so group equality is structural rather than textual. */
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const record = v as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canon(record[k])}`).join(",")}}`;
}
