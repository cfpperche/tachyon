/**
 * spec 250 Step 5b — the plugin SOURCE resolver (pure, no I/O). Parses a remote source-spec string into a
 * normalized `GitSource` the fetcher (next increment) clones into a verified cache for `loadPlugin`. v1 is
 * git-based + remote-only — no local-path source, no registry (that's v2, built on top → a registry resolves
 * `name@version` to a git ref; the fetch stays git). Fail-closed + error-accumulating; never throws, never
 * touches the network or fs. See docs/specs/250-tachyon-plugin-system/sourcing.md.
 *
 * Grammar (locked):
 *   github:<org>/<repo>@<ref>[#path=<subdir>]
 *   git+https://<host>/<path>/<repo>.git@<ref>[#path=<subdir>]
 * `@<ref>` is REQUIRED (no silent default-branch — floating must be explicit via `@HEAD`).
 * `#path=` is the unambiguous subdir delimiter (the `org/repo/path@ref` shorthand is rejected).
 *
 * This is the PUBLIC source contract, AND a ref/path flows into a future `git` shell-out, so parsing is
 * strict: a ref is validated against git's check-ref-format rules INCLUDING no leading `-` (so the fetcher
 * can never be tricked into `git fetch --upload-pack=…`-style argument injection).
 */

import { checkContainedRelPath } from "@tachyon/engine/plugins/paths.js";

const MAX_SPEC_LEN = 2048;
const SHA_RE = /^[0-9a-fA-F]{40}$/; // a full git commit SHA (case-insensitive; normalized to lowercase on output)
// GitHub owner: alphanumeric with single internal hyphens, no leading/trailing hyphen (≤ 39 chars).
const GH_OWNER_RE = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
// GitHub repo: alphanumeric / . / _ / - (the literal `.git` suffix is rejected separately).
const GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_CHARS_RE = /^[A-Za-z0-9._/-]+$/; // the allowed char class; structure is checked by validRefFormat
const PORT_RE = /^\d{1,5}$/;

/** How the ref pins (or doesn't): a full SHA is reproducible; a tag/branch is named; `HEAD` is floating. */
export type RefKind = "sha" | "named" | "head";

export interface GitSource {
  kind: "git";
  /** the original source-spec, verbatim (provenance). */
  spec: string;
  /** normalized clone URL, e.g. `https://github.com/org/repo.git`. */
  remote: string;
  /** the ref as written (tag / branch / 40-hex SHA, lowercased / `HEAD`). */
  ref: string;
  refKind: RefKind;
  /** contained POSIX-relative subdir (the plugin root), when `#path=` was given. */
  subdir?: string;
}

export interface SourceParseResult {
  source?: GitSource;
  errors: string[];
}

/** Approximate `git check-ref-format` for a non-HEAD, non-SHA ref. Rejects the structures git forbids AND a
 *  leading `-` (argument-injection guard for the fetcher). Char class is enforced by the caller. */
function validRefFormat(ref: string): boolean {
  if (ref.startsWith("-")) return false; // would look like a git CLI flag once the fetcher shells out
  if (ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.endsWith(".")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return false;
  for (const comp of ref.split("/")) {
    if (comp.length === 0 || comp.startsWith(".") || comp.endsWith(".lock")) return false;
  }
  return true;
}

/** A path segment list (for a git+https URL path or a host) is free of empty / `.` / `..` segments. */
function noDotSegments(parts: string[]): boolean {
  return parts.every((p) => p.length > 0 && p !== "." && p !== "..");
}

function validHost(host: string): boolean {
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
  return host.split(".").every((label) => label.length > 0 && !label.startsWith("-") && !label.endsWith("-"));
}

/** Split off an optional `#path=<subdir>` fragment. Returns the base spec + the subdir (validated). */
function splitFragment(spec: string, errors: string[]): { base: string; subdir?: string } {
  const hash = spec.indexOf("#");
  if (hash === -1) return { base: spec };
  const base = spec.slice(0, hash);
  const frag = spec.slice(hash + 1);
  if (frag.includes("#")) {
    errors.push("source has more than one '#' fragment");
    return { base };
  }
  if (!frag.startsWith("path=")) {
    errors.push(`unknown fragment '#${frag}' (only '#path=<subdir>' is supported)`);
    return { base };
  }
  const subdir = frag.slice("path=".length);
  if (subdir.length === 0) {
    errors.push("#path= is empty");
    return { base };
  }
  const check = checkContainedRelPath(subdir);
  if (!check.ok) {
    errors.push(`#path= '${subdir}' is not a contained relative path (${check.reason})`);
    return { base };
  }
  return { base, subdir };
}

/** Split a base spec into `<locator>@<ref>` on the LAST '@' (refs never contain '@'; userinfo is rejected
 *  later). Validates the ref's char class + structure. Pushes an error when `@<ref>` is missing or invalid. */
function splitRef(base: string, errors: string[]): { locator: string; ref?: string; refKind?: RefKind } {
  const at = base.lastIndexOf("@");
  if (at <= 0 || at === base.length - 1) {
    errors.push("missing required '@<ref>' (a tag, branch, 40-hex SHA, or '@HEAD' for the default branch)");
    return { locator: base };
  }
  const locator = base.slice(0, at);
  const raw = base.slice(at + 1);
  if (raw === "HEAD") return { locator, ref: "HEAD", refKind: "head" };
  if (SHA_RE.test(raw)) return { locator, ref: raw.toLowerCase(), refKind: "sha" };
  if (!REF_CHARS_RE.test(raw)) {
    errors.push(`ref '${raw}' has invalid characters`);
    return { locator };
  }
  if (!validRefFormat(raw)) {
    errors.push(`ref '${raw}' is not a valid git ref (no leading '-', no '..', no leading/trailing slash, no '.lock')`);
    return { locator };
  }
  return { locator, ref: raw, refKind: "named" };
}

/**
 * Parse + validate a remote source-spec into a `GitSource`. Fail-closed: collects every problem and only
 * returns a `source` when wholly valid. Never throws; no network/fs.
 */
export function parseSource(spec: string): SourceParseResult {
  if (typeof spec !== "string" || spec.trim().length === 0) return { errors: ["source: required, a non-empty string"] };
  if (spec.length > MAX_SPEC_LEN) return { errors: ["source: too long"] };
  const trimmed = spec.trim();

  const errors: string[] = [];
  const { base, subdir } = splitFragment(trimmed, errors);
  const { locator, ref, refKind } = splitRef(base, errors);

  let remote: string | undefined;

  if (locator.startsWith("github:")) {
    const orgRepo = locator.slice("github:".length);
    const slash = orgRepo.indexOf("/");
    const owner = slash === -1 ? orgRepo : orgRepo.slice(0, slash);
    const repo = slash === -1 ? "" : orgRepo.slice(slash + 1);
    if (slash === -1 || repo.includes("/")) {
      errors.push(`github: source must be 'github:<org>/<repo>' (got '${orgRepo}')`);
    } else if (!GH_OWNER_RE.test(owner)) {
      errors.push(`github: owner '${owner}' is not a valid GitHub user/org name`);
    } else if (repo.endsWith(".git") || repo === "." || repo === ".." || !GH_REPO_RE.test(repo)) {
      errors.push(`github: repo '${repo}' is not a valid repository name (and must not include the '.git' suffix)`);
    } else {
      remote = `https://github.com/${owner}/${repo}.git`;
    }
  } else if (locator.startsWith("git+https://")) {
    const rest = locator.slice("git+https://".length); // host[:port]/path…/repo.git
    if (rest.includes("@")) {
      errors.push("git+https source must not contain credentials ('user:pass@host')");
    } else {
      const slash = rest.indexOf("/");
      const hostPort = slash === -1 ? rest : rest.slice(0, slash);
      const pathPart = slash === -1 ? "" : rest.slice(slash + 1);
      const colon = hostPort.lastIndexOf(":");
      const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
      const port = colon === -1 ? "" : hostPort.slice(colon + 1);
      const portOk = port === "" || (PORT_RE.test(port) && Number(port) >= 1 && Number(port) <= 65535);
      const segments = pathPart.split("/");
      if (!validHost(host)) {
        errors.push(`git+https source has an invalid host '${host}'`);
      } else if (!portOk) {
        errors.push(`git+https source has an invalid port '${port}'`);
      } else if (!pathPart.endsWith(".git") || pathPart.length <= 4) {
        errors.push("git+https source path must end in '.git'");
      } else if (!/^[A-Za-z0-9._/-]+$/.test(pathPart) || !noDotSegments(segments)) {
        errors.push("git+https source path has invalid or '.'/'..' segments");
      } else {
        remote = `https://${hostPort}/${pathPart}`;
      }
    }
  } else if (/^git\+ssh:\/\//.test(locator) || /^[^/]+@[^/]+:/.test(locator)) {
    errors.push("ssh sources are not supported in v1 (use github: or git+https://)");
  } else if (locator.startsWith(".") || locator.startsWith("/") || locator.startsWith("file:")) {
    errors.push("local-path sources are not supported in v1 (sourcing is remote git-only)");
  } else {
    errors.push(`unrecognized source '${locator}' (expected 'github:<org>/<repo>' or 'git+https://…')`);
  }

  if (errors.length > 0 || !remote || !ref || !refKind) return { errors };

  return { source: { kind: "git", spec: trimmed, remote, ref, refKind, ...(subdir ? { subdir } : {}) }, errors: [] };
}

// ── semver-tag helpers (spec 266 — latest-version detection) ────────────────
// Pure, no I/O. A "semver tag" is an optionally `v`-prefixed major[.minor[.patch]] with an ignored
// prerelease/build suffix (`v0.6.0`, `1.2`, `0.6.0-rc1`). Anything else (`nightly`, `latest`) is NOT a semver
// tag, so it is never ordered or offered as a bump.

const SEMVER_TAG_RE = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/;

/** Parse a semver-ish tag into its numeric triple (missing minor/patch → 0), or null when it is not semver. */
export function parseSemverTag(tag: string): { major: number; minor: number; patch: number } | null {
  if (typeof tag !== "string") return null;
  const m = SEMVER_TAG_RE.exec(tag.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/**
 * Compare two versions/tags by numeric major→minor→patch (prerelease/build ignored for ordering). Tolerant of a
 * leading `v` AND of a plain manifest version (`2.0.0`), so it is the single comparator for both the plugin
 * manifest version (engine downgrade check) and repo tags — the two policies can never drift. A non-parseable
 * input compares as `0.0.0`. <0 if a<b, 0 if equal, >0 if a>b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverTag(a) ?? { major: 0, minor: 0, patch: 0 };
  const pb = parseSemverTag(b) ?? { major: 0, minor: 0, patch: 0 };
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * Swap the `@<ref>` of a source-spec for `newRef`, preserving the locator and a trailing `#path=` fragment.
 * Reuses `parseSource`'s split discipline (single `#` fragment, ref on the LAST `@`) so no second grammar is
 * invented; the result is re-parsed (and thus re-validated) by `parseSource` downstream. Returns the spec
 * unchanged when there is no `@<ref>` to rewrite. Pure string surgery — does NOT validate `newRef`.
 */
export function rewriteRef(spec: string, newRef: string): string {
  if (typeof spec !== "string") return spec;
  const trimmed = spec.trim();
  const hash = trimmed.indexOf("#");
  const base = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const frag = hash === -1 ? "" : trimmed.slice(hash); // includes the leading '#'
  const at = base.lastIndexOf("@");
  if (at <= 0 || at === base.length - 1) return spec; // no parseable @<ref> — leave untouched
  return `${base.slice(0, at)}@${newRef}${frag}`;
}
