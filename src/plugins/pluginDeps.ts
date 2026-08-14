/**
 * spec 276 — plugin dependencies (declared requirements SURFACED at install, never installer-enforced, never a
 * cascade). The `PluginManifest.dependencies` field ({name, range}) was a dormant TYPE slot; this wires the check:
 * for each DIRECT declared dep, look it up in the lockfile and classify satisfied/out-of-range/missing. Pure (no
 * IO) → unit-tested. Reuses the spec-266 semver helpers (parseSemverTag/compareSemver) — NOT the transitive
 * `semver` lib. Caret/tilde are the common author ranges; 0.x caret is treated major-wise (approximate, documented).
 */
import type { PluginDep } from "@tachyon/engine/plugins/manifest.js";
import type { Lockfile } from "@tachyon/engine/plugins/lockfile.js";
import { parseSemverTag, compareSemver } from "./source.js";

export type DependencyStatus = "satisfied" | "out-of-range" | "missing";

export interface DependencyState {
  name: string;
  range: string;
  status: DependencyStatus;
  /** the installed version (when present), for the drawer to show "have X, want <range>". */
  installedVersion?: string;
}

/**
 * Does `version` satisfy `range`? Supports `*`/empty (any), exact `X.Y.Z`, `^X.Y.Z` (same major, >= base),
 * `~X.Y.Z` (same major+minor, >= base), and `>=X.Y.Z`. Anything unparseable → false (fail-closed). v1 scope:
 * a single comparator (no ranges like `>=1 <2` / `||`) — enough for author pins like `^2.1.0`.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const r = (range ?? "").trim();
  if (r === "" || r === "*" || r === "x" || r === "X") return parseSemverTag(version) !== null;

  const v = parseSemverTag(version);
  if (!v) return false;

  const op = r.startsWith("^") ? "^" : r.startsWith("~") ? "~" : r.startsWith(">=") ? ">=" : "=";
  const baseStr = r.replace(/^(\^|~|>=)/, "").trim();
  const base = parseSemverTag(baseStr);
  if (!base) return false;
  const cmp = compareSemver(version, baseStr); // <0 below base, 0 equal, >0 above

  switch (op) {
    case "=":
      return cmp === 0;
    case ">=":
      return cmp >= 0;
    case "^": // caret: >= base AND same major (major-wise; approximate for 0.x, documented)
      return cmp >= 0 && v.major === base.major;
    case "~": // tilde: >= base AND same major+minor
      return cmp >= 0 && v.major === base.major && v.minor === base.minor;
  }
  return false;
}

/** Classify one declared dependency against the lockfile (the installed plugins). Pure. */
export function dependencyState(dep: PluginDep, lockfile: Lockfile | undefined): DependencyState {
  const lock = lockfile?.plugins?.[dep.name];
  if (!lock) return { name: dep.name, range: dep.range, status: "missing" };
  const status: DependencyStatus = satisfiesRange(lock.version, dep.range) ? "satisfied" : "out-of-range";
  return { name: dep.name, range: dep.range, status, installedVersion: lock.version };
}

/** Classify all DIRECT declared dependencies (no transitive walk). Pure. */
export function dependencyStates(deps: readonly PluginDep[], lockfile: Lockfile | undefined): DependencyState[] {
  return deps.map((d) => dependencyState(d, lockfile));
}
