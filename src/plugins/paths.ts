/**
 * spec 250 — shared path-safety helpers for the plugin system. A plugin's declared paths and the
 * lockfile's recorded target paths are the untrusted/uninstall surface, so they must be contained,
 * POSIX-relative paths (no escape, no absolute, no platform separators). Validated by SEGMENT, not by
 * substring matching (which over-rejects `foo..bar` and under-covers Windows `C:\`, UNC, null bytes).
 */

const CONTROL_RE = /[\x00-\x1f\x7f]/; // C0 controls + DEL (explicit escapes — a literal class silently broke hyphens)
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/; // one path segment: no separators, no ':', no controls

export interface PathCheck {
  ok: boolean;
  reason?: string;
}

/**
 * True iff `raw` is a contained, POSIX-style relative path: non-empty, no control/null chars, no
 * backslashes, not absolute, and every segment is a safe non-`.`/`..` token. A single trailing `/`
 * is tolerated. `maxLen` bounds it for untrusted input.
 */
export function checkContainedRelPath(raw: unknown, maxLen = 1024): PathCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "must be a non-empty string" };
  if (raw.length > maxLen) return { ok: false, reason: "path is too long" };
  if (raw.includes("\0") || CONTROL_RE.test(raw)) return { ok: false, reason: "path contains control/null characters" };
  if (raw.includes("\\")) return { ok: false, reason: "use POSIX '/' separators (no backslashes)" };
  if (raw.startsWith("/")) return { ok: false, reason: "must be relative (no leading '/')" };
  const norm = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  for (const seg of norm.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return { ok: false, reason: "has an empty, '.' or '..' segment" };
    if (!SEGMENT_RE.test(seg)) return { ok: false, reason: `has an invalid path segment '${seg}'` };
  }
  return { ok: true };
}

export function isContainedRelPath(raw: unknown, maxLen = 1024): boolean {
  return checkContainedRelPath(raw, maxLen).ok;
}

/**
 * A plugin's materialized payload root (e.g. `.tachyon/plugins/<name>/claude`) is substituted into hook
 * command strings, so it must be free of shell-hazardous characters. Tachyon generates this path from a
 * validated kebab plugin name, so this is defense-in-depth, not the primary guard.
 */
export function isSafePluginRoot(raw: string): boolean {
  if (!isContainedRelPath(raw)) return false;
  return !/[\s"'`$;&|<>(){}*?!#~]/.test(raw); // no whitespace or shell metacharacters
}

/**
 * spec 321 (debate p-763d4b) — the ABSOLUTE plugin root baked into rendered hook commands. Hook commands
 * execute via `sh -c` against a cwd Tachyon does not control (claude follows the agent shell's `cd`), so
 * the root must be absolute; and it is embedded inside a double-quoted sh test, so it must stay free of
 * whitespace/shell metacharacters — a workspace path that violates this fails the merge closed rather
 * than ever writing brokenly-quoted hooks.
 */
export function isSafeAbsolutePluginRoot(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return false;
  if (!raw.startsWith("/")) return false;
  if (raw.includes("\0") || CONTROL_RE.test(raw) || raw.includes("\\")) return false;
  for (const seg of raw.slice(1).split("/")) {
    if (seg === "." || seg === "..") return false; // no traversal; empty segs ("//") also rejected below
    if (seg === "") return false;
  }
  return !/[\s"'`$;&|<>(){}*?!#~]/.test(raw); // same shell-hazard class as the relative guard
}
