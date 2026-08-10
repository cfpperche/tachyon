/**
 * spec 250 — pure loader + validator for a Tachyon plugin manifest (`tachyon-plugin.json`).
 * Mirrors loadPipeline/loadConfig's fail-closed, error-accumulating style: returns
 * `{manifest?, errors}` and never throws on bad input. No side effects — the install
 * engine consumes a validated PluginManifest; the per-runtime adapters consume its blocks.
 *
 * This is the UNTRUSTED-marketplace boundary: it parses manifests authored by third parties,
 * so validation is fail-closed and security-minded (path containment, key closure, resource caps).
 *
 * Design: a Tachyon plugin is an AGGREGATE of each runtime's NATIVE config block (no
 * cross-runtime abstraction). The manifest declares which runtimes the plugin supports and
 * points at each runtime's native block directory. See docs/specs/250-tachyon-plugin-system/.
 */

// plugin + dependency names: lowercase kebab, leading letter, no trailing/double hyphen (marketplace-safe).
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/; // major.minor.patch (+ optional prerelease)
const CONTROL_RE = /[\x00-\x1f\x7f]/; // C0 controls + DEL — rejected in free-form strings
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/; // a single block-path segment (no separators, no ':', no controls)
const EXEC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // spec 289 — a bare executable name (chromium-browser, python3.11); no path sep
const MAX_EXTERNAL_NAMES = 8; // spec 289 — cap on an external tool's candidate-name list

// Resource caps — this ingests untrusted manifests, so bound everything before trusting it.
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_STR = 1024; // any single free-form string (description, a path, a range)
const MAX_LIST = 64; // runtimes / dependencies entries

/** Runtimes Tachyon can wire a plugin block into. v1 = claude + codex + grok; gemini is deferred to v2. */
export const SUPPORTED_RUNTIMES = ["claude", "codex", "grok"] as const;
export type Runtime = (typeof SUPPORTED_RUNTIMES)[number];

/** Known but not-yet-supported — declared so we give a precise "deferred" error, not "unknown runtime". */
const DEFERRED_RUNTIMES: ReadonlySet<string> = new Set(["gemini"]);

/** Git hook events a plugin may declare (spec 264). RUNTIME-AGNOSTIC: a git-hook fires for every actor at
 *  git time, not through a runtime.
 *
 *  `pre-push` was added because the machinery below was already generic over events — only this allowlist
 *  named a single one. It is what lets a plugin gate what LANDS, not just what is committed: Tachyon already
 *  gates delegated work at landing (`verify_task`), while a direct push had no gate at all.
 *
 *  A pre-push leaf receives git's ref lines on STDIN (`<local ref> <local sha> <remote ref> <remote sha>`),
 *  so it can scope itself to a protected branch instead of taxing every push. */
export const GIT_HOOK_EVENTS = ["pre-commit", "pre-push"] as const;
export type GitHookEvent = (typeof GIT_HOOK_EVENTS)[number];
const GIT_HOOK_EVENT_SET: ReadonlySet<string> = new Set(GIT_HOOK_EVENTS);

/** A plugin's git-hook leaf: EITHER a contained plugin-payload script, OR a direct argv vector (no shell). */
export type GitHookLeaf = { kind: "script"; path: string } | { kind: "argv"; argv: string[] };

const SHA256_RE = /^[0-9a-f]{64}$/; // a lowercase-hex sha256 digest (tool artifact / extracted-binary identity)

/** Explicit, libc-qualified platform keys a `tools` pin may target (spec 265, task-0 gate (d)). v1 =
 *  linux/macOS only (Windows excluded); the libc split is mandatory because a glibc binary won't load on musl. */
export const TOOL_PLATFORM_KEYS = ["linux-x64-glibc", "linux-x64-musl", "linux-arm64-glibc", "linux-arm64-musl", "darwin-x64", "darwin-arm64"] as const;
export type ToolPlatformKey = (typeof TOOL_PLATFORM_KEYS)[number];
const TOOL_PLATFORM_KEY_SET: ReadonlySet<string> = new Set(TOOL_PLATFORM_KEYS);

/** Archive container types a tool artifact may ship in (spec 265, task-0 gate (a)). v1 = tar.gz/tgz ONLY;
 *  `zip` is DEFERRED (loads-but-rejects with a forward-compatible message) — see docs/specs/265 notes gate (a). */
export const TOOL_ARCHIVE_TYPES = ["tar.gz", "tgz"] as const;
export type ToolArchiveType = (typeof TOOL_ARCHIVE_TYPES)[number];

/** When the downloaded artifact is an archive, the single regular file to extract + its own pinned hash. */
export interface ToolArchive {
  type: ToolArchiveType;
  /** the contained POSIX-relative path of the ONE regular file to extract as the executable. */
  innerPath: string;
  /** 64-hex sha256 of the EXTRACTED executable bytes (the install identity — separate from the artifact hash). */
  binSha256: string;
}

/** One platform's pinned artifact: an HTTPS URL + the artifact's sha256, optionally an archive to unwrap. */
export interface ToolPlatform {
  url: string;
  /** 64-hex sha256 of the downloaded artifact bytes (verified before any extraction/install). */
  sha256: string;
  archive?: ToolArchive;
}

/**
 * spec 269 — a launcher-ENFORCED launch policy for a tool: env vars + args the `_tachyon-tool` launcher always
 * applies, and conflicting agent args it refuses. Turns a soft, skill-mandated safety flag into a mechanical one
 * ON THE LAUNCHER PATH (it does NOT sandbox a same-user agent that re-execs the bytes directly — see spec 269).
 */
export interface ToolLaunchPolicy {
  /** env vars the launcher force-sets (overriding the parent env for these keys) before exec. */
  env?: Record<string, string>;
  /** args the launcher always applies, in a position the agent cannot neutralize. */
  args?: string[];
  /** agent argv containing any of these flags → the launcher REFUSES to exec (fail closed, not flag-vs-env precedence). */
  denyArgs?: string[];
  /** spec 270/271 — the flag via which the launcher feeds the plugin's HUMAN-OWNED config file to the tool (e.g.
   *  `--config`): the launcher expands it to `<configArg> <resolved workspace config path>` from the plugin's
   *  `config.file`. The agent must not pass its own (list the same flag in `denyArgs`). No-op if the plugin
   *  declares no `config`. */
  configArg?: string;
  /** spec 271 — env var names the launcher REMOVES from the child env before applying forced env, so an agent
   *  cannot override the human config via env (tool precedence is typically CLI > env > config-file). Exact names. */
  scrubEnv?: string[];
  /** only mode in v1 — the policy is enforced, not advisory (room for 'warn'/'default' later). */
  mode: "force";
}

/** A single declared tool: a pinned per-platform binary Tachyon may fetch+verify+install, or detect on the host. */
export interface ToolDecl {
  /** the pinned version label (free-form, e.g. '8.18.4' or 'v1.2.3') — surfaced at consent, not parsed as semver. */
  version: string;
  /** argv to probe a host-installed tool's EXACT version for detect-first (spec 265 detect path). Optional. */
  versionCommand?: string[];
  /** optional gate: a host-detected binary is only trusted when its sha256 matches this. */
  allowedHostSha256?: string;
  /** at least one explicit platform key → its pinned artifact. */
  platforms: Partial<Record<ToolPlatformKey, ToolPlatform>>;
  /** spec 269 — an optional launcher-enforced launch policy (forced env/args, refused args). */
  launchPolicy?: ToolLaunchPolicy;
}

/** spec 284 — one platform's pinned DATA artifact: an HTTPS URL + the file's sha256. NO archive (single-file v1). */
export interface DataPlatform {
  url: string;
  /** 64-hex sha256 of the downloaded data file (the content-address identity; verified before install). */
  sha256: string;
}

/**
 * spec 284 — a declared DATA artifact: a pinned, sha256-verified file the engine fetches + content-addresses +
 * installs READ-ONLY (never executed — no smoke, no launch policy). The non-executable sibling of `ToolDecl`, for
 * model weights / rulesets / wordlists a tool READS. EITHER a single cross-platform `{url, sha256}` OR a per-platform
 * `platforms` map (mutually exclusive). Archive bundles are rejected in v1 (single-file only).
 */
export interface DataDecl {
  /** the pinned version label (free-form; surfaced at consent, not parsed as semver). */
  version: string;
  /** the on-disk leaf filename (a single path segment); defaults to the data name. */
  fileName?: string;
  /** a single cross-platform artifact — mutually exclusive with `platforms`. */
  single?: DataPlatform;
  /** per-platform pinned artifacts — mutually exclusive with `single`. */
  platforms?: Partial<Record<ToolPlatformKey, DataPlatform>>;
}

/** spec 285 — the package managers a plugin may declare an assisted-install argv for. Tachyon detects which is
 *  present on the host and runs the matching argv; an unknown/absent PM degrades to the `manual` guidance. */
export const PACKAGE_MANAGERS = ["apt", "dnf", "pacman", "apk", "zypper", "brew", "choco"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];
const PACKAGE_MANAGER_SET: ReadonlySet<string> = new Set(PACKAGE_MANAGERS);

/** spec 285 — one PM's assisted-install command as STRUCTURED ARGV (run argv-directly, NEVER a shell string). */
export interface ExternalToolInstall {
  argv: string[];
}

/**
 * spec 285 — an EXTERNAL system tool a plugin's skill needs but Tachyon does NOT provision (a heavy/native/
 * package-managed binary, e.g. whisper-cli, ffmpeg). Declares how to DETECT it + a per-package-manager assisted-
 * install argv + required `manual` guidance. NOT a provisioned tool (265, pinned binary) nor a plugin dep (276).
 */
export interface ExternalToolDecl {
  /** spec 289 — OPTIONAL ordered candidate binary names (e.g. a browser: `["google-chrome", "chromium"]`).
   *  Resolution tries each on the clean PATH and returns the FIRST that is trusted AND (if `detect` is set) passes
   *  the probe. When omitted, the single candidate is the manifest KEY (exact spec-285 behavior). When present, ONLY
   *  these names are tried — the key is NOT auto-included (list it explicitly if it is a real binary). */
  names?: string[];
  /** optional detect probe ARGS passed to the RESOLVED trusted tool binary (e.g. `["--version"]`; exit 0 = present).
   *  The binary executed is ALWAYS the clean-PATH-resolved trusted path — NEVER a manifest-supplied path (spec 285
   *  security). Default (omitted) = the tool merely needs to resolve on a clean PATH. */
  detect?: string[];
  /** per-package-manager assisted-install argv (at least one). The first non-`sudo` exe must match the PM family. */
  install: Partial<Record<PackageManager, ExternalToolInstall>>;
  /** REQUIRED manual guidance (a string or URL) shown when no install argv matches the host's platform/PM. */
  manual: string;
}

/**
 * spec 270 — a plugin's human-facing config: a payload file the human edits (through the Plugins Config editor),
 * with an OPTIONAL payload-supplied JSON Schema file the editor associates for live validation. The config file is
 * the human's to own — the engine seeds it from the payload on first install and an update never clobbers it.
 * v1 ships NO Tachyon-authored schema engine: a plugin that wants validation supplies its own schema file (spec 271
 * reuses agent-browser's published schema). Both paths are contained, payload-relative FILES (no dirs, no escape).
 */
export interface ConfigDecl {
  /** payload-relative path of the config file the human edits (also the seeded default). */
  file: string;
  /** optional payload-relative JSON Schema file the editor associates for validation. */
  schemaFile?: string;
}

export const VIEW_SURFACES = ["editor", "sidebar"] as const;
export type ViewSurface = (typeof VIEW_SURFACES)[number];
const VIEW_SURFACE_SET: ReadonlySet<string> = new Set(VIEW_SURFACES);
export const VIEW_FLEET_SCOPES = ["summary"] as const;
export type ViewFleetScope = (typeof VIEW_FLEET_SCOPES)[number];
const VIEW_FLEET_SCOPE_SET: ReadonlySet<string> = new Set(VIEW_FLEET_SCOPES);
const VIEW_ACTION_RE = /^[A-Za-z][A-Za-z0-9._:-]*$/;

/** spec 349 — a runtime-agnostic plugin UI surface declaration. */
export interface ViewDecl {
  id: string;
  title: string;
  surface: ViewSurface;
  /** payload-relative, contained, self-contained HTML entry point. */
  entry: string;
  /** optional contained icon asset for future UI registration. */
  icon?: string;
  /** v1 exposes only a name-free summary projection. */
  fleet: ViewFleetScope;
  /** v1 action names are consented individually; the broker allowlist is implemented in later tasks. */
  actions: string[];
}

/** Recognized top-level manifest fields — anything else fails closed (typo-catching; v2 fields fail on v1). */
const KNOWN_FIELDS: ReadonlySet<string> = new Set(["name", "version", "description", "runtimes", "dependencies", "blocks", "gitHooks", "tools", "data", "externalTools", "config", "docsUrl", "views"]);

/** A parsed `name@range` dependency on another plugin (e.g. `some-base-plugin@^1`). */
export interface PluginDep {
  name: string;
  /** the raw version range as written (e.g. `^1`, `^1.2.0`, `*`); semver resolution is the installer's job. */
  range: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  /** the runtimes this plugin supports (deduped, each ∈ SUPPORTED_RUNTIMES). spec 264: MAY be empty — a
   *  runtime-agnostic git-hook-only plugin declares none (a per-runtime capability needs ≥1, enforced at load). */
  runtimes: Runtime[];
  /** other plugins this one requires installed first (e.g. some-base-plugin). Empty when omitted. */
  dependencies: PluginDep[];
  /** runtime → path of that runtime's native hooks block dir, RELATIVE to the plugin root. OPTIONAL per
   *  runtime (spec 251): keys ⊆ runtimes; absent for a skills-only plugin or a runtime with no hooks. */
  blocks: Partial<Record<Runtime, string>>;
  /** runtime-agnostic git hooks (spec 264). Each declared event → a leaf (a payload script or an argv vector).
   *  v1: only `pre-commit`. Empty when omitted. Materialized via a Tachyon-managed chaining dispatcher. */
  gitHooks: Partial<Record<GitHookEvent, GitHookLeaf>>;
  /** author-pinned, per-platform binaries this plugin provisions (spec 265). name → declaration. Empty when
   *  omitted. Fetch+verify+content-address-install, human-consented; referenced by `${tool:<name>}` in argv leaves. */
  tools: Record<string, ToolDecl>;
  /** spec 284 — author-pinned DATA artifacts (non-executable: model weights, rulesets). name → declaration. Empty
   *  when omitted. Fetch+verify+content-address-install READ-ONLY; resolved by a skill via the `_tachyon-data` shim. */
  data: Record<string, DataDecl>;
  /** spec 285 — EXTERNAL system tools the plugin needs but Tachyon does NOT provision (declare+detect+assisted-
   *  install). name → declaration. Empty when omitted. */
  externalTools: Record<string, ExternalToolDecl>;
  /** spec 270 — OPTIONAL human-facing config the plugin ships (a payload config file + optional schema file). */
  config?: ConfigDecl;
  /** spec 270 — OPTIONAL https documentation URL surfaced as the plugin card's "Docs" button. */
  docsUrl?: string;
  /** spec 349 — runtime-agnostic UI surfaces contributed by this plugin. Empty/omitted when none. */
  views?: ViewDecl[];
}

export interface ManifestParseResult {
  manifest?: PluginManifest;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a string as a contained, POSIX-relative path (no escape, no absolute, no platform separators).
 * Pushes an error under `label` and returns false on any violation. A single trailing `/` is allowed
 * (block dirs are commonly written `claude/`). Shared by `blocks` and `gitHooks` leaf paths.
 */
function validContainedPath(label: string, raw: unknown, errors: string[]): boolean {
  if (typeof raw !== "string" || raw.length === 0) {
    errors.push(`${label}: must be a non-empty relative path`);
    return false;
  }
  if (raw.length > MAX_STR) {
    errors.push(`${label}: path is too long`);
    return false;
  }
  if (raw.includes("\0") || CONTROL_RE.test(raw)) {
    errors.push(`${label}: path contains control/null characters`);
    return false;
  }
  if (raw.includes("\\")) {
    errors.push(`${label}: use POSIX '/' separators (no backslashes)`);
    return false;
  }
  if (raw.startsWith("/")) {
    errors.push(`${label}: '${raw}' must be relative (no leading '/')`);
    return false;
  }
  const norm = raw.endsWith("/") ? raw.slice(0, -1) : raw; // tolerate one trailing slash
  for (const seg of norm.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      errors.push(`${label}: '${raw}' has an empty, '.' or '..' segment (must stay inside the plugin)`);
      return false;
    }
    if (!PATH_SEGMENT_RE.test(seg)) {
      errors.push(`${label}: '${raw}' has an invalid path segment '${seg}'`);
      return false;
    }
  }
  return true;
}

function validBlockPath(rt: string, raw: unknown, errors: string[]): boolean {
  return validContainedPath(`blocks.${rt}`, raw, errors);
}

/** Parse one git-hook event's declaration: exactly one of `leaf` (a contained payload script) or `argv`
 *  (a direct exec vector, no shell). Fail-closed. */
function parseGitHookLeaf(event: string, raw: unknown, errors: string[]): GitHookLeaf | null {
  if (!isPlainObject(raw)) {
    errors.push(`gitHooks.${event}: must be an object with exactly one of 'leaf' or 'argv'`);
    return null;
  }
  const hasLeaf = raw.leaf !== undefined;
  const hasArgv = raw.argv !== undefined;
  if (hasLeaf === hasArgv) {
    errors.push(`gitHooks.${event}: exactly one of 'leaf' (a payload script) or 'argv' (an exec vector) is required`);
    return null;
  }
  if (hasLeaf) {
    if (!validContainedPath(`gitHooks.${event}.leaf`, raw.leaf, errors)) return null;
    return { kind: "script", path: raw.leaf as string };
  }
  if (!Array.isArray(raw.argv) || raw.argv.length === 0) {
    errors.push(`gitHooks.${event}.argv: must be a non-empty list of strings`);
    return null;
  }
  if (raw.argv.length > MAX_LIST) {
    errors.push(`gitHooks.${event}.argv: too many entries`);
    return null;
  }
  const argv: string[] = [];
  for (const a of raw.argv) {
    if (typeof a !== "string" || a.length === 0 || a.length > MAX_STR || a.includes("\0") || CONTROL_RE.test(a)) {
      errors.push(`gitHooks.${event}.argv: every entry must be a non-empty, control-free string`);
      return null;
    }
    argv.push(a);
  }
  return { kind: "argv", argv };
}

/** Parse the optional top-level `gitHooks` map: event → leaf. Unknown/deferred events fail closed (v1 =
 *  `pre-commit` only). Built on a null-proto accumulator (defense-in-depth against `__proto__` keys). */
function parseGitHooks(raw: unknown, errors: string[]): Partial<Record<GitHookEvent, GitHookLeaf>> {
  const out: Record<string, GitHookLeaf> = Object.create(null);
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    errors.push("gitHooks: when present, a map of git-event → { leaf | argv }");
    return {};
  }
  for (const [event, decl] of Object.entries(raw)) {
    if (!GIT_HOOK_EVENT_SET.has(event)) {
      errors.push(`gitHooks.${event}: '${event}' is not a supported git hook event (v1: ${GIT_HOOK_EVENTS.join(", ")})`);
      continue;
    }
    const leaf = parseGitHookLeaf(event, decl, errors);
    if (leaf) out[event] = leaf;
  }
  return { ...out } as Partial<Record<GitHookEvent, GitHookLeaf>>;
}

/** Validate a non-empty, control-free argv vector (capped). Shared by `tools.*.versionCommand`. */
function parseArgvVector(label: string, raw: unknown, errors: string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${label}: must be a non-empty list of strings`);
    return null;
  }
  if (raw.length > MAX_LIST) {
    errors.push(`${label}: too many entries`);
    return null;
  }
  const out: string[] = [];
  for (const a of raw) {
    if (typeof a !== "string" || a.length === 0 || a.length > MAX_STR || a.includes("\0") || CONTROL_RE.test(a)) {
      errors.push(`${label}: every entry must be a non-empty, control-free string`);
      return null;
    }
    out.push(a);
  }
  return out;
}

/** Validate a 64-char lowercase-hex sha256 string. */
function validSha256(label: string, raw: unknown, errors: string[]): boolean {
  if (typeof raw !== "string" || !SHA256_RE.test(raw)) {
    errors.push(`${label}: must be a 64-char lowercase-hex sha256 digest`);
    return false;
  }
  return true;
}

/** Validate a fetch URL: a parseable, https-only URL with a host. Tools download + EXECUTE, so https is mandatory. */
function validHttpsUrl(label: string, raw: unknown, errors: string[]): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_STR || raw.includes("\0") || CONTROL_RE.test(raw)) {
    errors.push(`${label}: must be a non-empty, control-free URL string`);
    return false;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    errors.push(`${label}: '${raw}' is not a valid URL`);
    return false;
  }
  if (u.protocol !== "https:") {
    errors.push(`${label}: must use https:// (got '${u.protocol}//')`);
    return false;
  }
  if (!u.hostname) {
    errors.push(`${label}: URL is missing a host`);
    return false;
  }
  return true;
}

/** Parse a tool's per-platform archive declaration. v1: tar.gz/tgz only (zip deferred → explicit reject). */
function parseToolArchive(toolName: string, key: string, raw: unknown, errors: string[]): ToolArchive | null {
  const where = `tools.${toolName}.platforms.${key}.archive`;
  if (!isPlainObject(raw)) {
    errors.push(`${where}: must be an object { type, innerPath, binSha256 }`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k !== "type" && k !== "innerPath" && k !== "binSha256") errors.push(`${where}: unknown field '${k}'`);
  }
  const type = raw.type;
  if (type === "zip") {
    errors.push(`${where}.type: 'zip' is not supported in v1 — use ${TOOL_ARCHIVE_TYPES.join("/")} (zip support is deferred)`);
    return null;
  }
  if (typeof type !== "string" || !(TOOL_ARCHIVE_TYPES as readonly string[]).includes(type)) {
    errors.push(`${where}.type: must be one of ${TOOL_ARCHIVE_TYPES.join(", ")}`);
    return null;
  }
  // innerPath is a single regular FILE — contained, and NOT a directory (no trailing slash).
  const innerOk = validContainedPath(`${where}.innerPath`, raw.innerPath, errors) && (() => {
    if (typeof raw.innerPath === "string" && raw.innerPath.endsWith("/")) {
      errors.push(`${where}.innerPath: must name a file, not a directory (no trailing '/')`);
      return false;
    }
    return true;
  })();
  const binOk = validSha256(`${where}.binSha256`, raw.binSha256, errors);
  if (!innerOk || !binOk) return null;
  return { type: type as ToolArchiveType, innerPath: raw.innerPath as string, binSha256: raw.binSha256 as string };
}

/** Parse one platform's pinned artifact: { url (https), sha256, archive? }. */
function parseToolPlatform(toolName: string, key: string, raw: unknown, errors: string[]): ToolPlatform | null {
  const where = `tools.${toolName}.platforms.${key}`;
  if (!isPlainObject(raw)) {
    errors.push(`${where}: must be an object { url, sha256, archive? }`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k !== "url" && k !== "sha256" && k !== "archive") errors.push(`${where}: unknown field '${k}'`);
  }
  const urlOk = validHttpsUrl(`${where}.url`, raw.url, errors);
  const shaOk = validSha256(`${where}.sha256`, raw.sha256, errors);
  let archive: ToolArchive | undefined;
  if (raw.archive !== undefined) {
    const a = parseToolArchive(toolName, key, raw.archive, errors);
    if (!a) return null;
    archive = a;
  }
  if (!urlOk || !shaOk) return null;
  return archive ? { url: raw.url as string, sha256: raw.sha256 as string, archive } : { url: raw.url as string, sha256: raw.sha256 as string };
}

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/; // POSIX-ish env var name (the launcher force-sets these)
// A policy must NOT force loader/exec-hijacking env: these change WHAT the tool executes (a preload, an alternate
// loader path, an interpreter option), which would smuggle code past the content-addressed binary's integrity.
// Rejected at parse → a malicious plugin can't inject them, and the consent never has to reason about them.
// The glibc/macOS dynamic-loader families are matched by PREFIX so the WHOLE family is covered (e.g.
// DYLD_FALLBACK_LIBRARY_PATH), not just a hand-listed subset (codex re-review).
const DANGEROUS_ENV_PREFIXES = ["LD_", "DYLD_"] as const;
const DANGEROUS_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH", "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5LIB", "PERL5OPT", "RUBYOPT", "RUBYLIB", "BASH_ENV",
  "ENV", "IFS", "GCONV_PATH",
]);
function isDangerousEnvKey(k: string): boolean {
  return DANGEROUS_ENV_PREFIXES.some((p) => k.startsWith(p)) || DANGEROUS_ENV_KEYS.has(k);
}

/** Parse a tool's optional launch policy (spec 269): forced env + args + refused args. Fail-closed; requires at
 *  least one of env/args/denyArgs (an empty 'force' policy is pointless) and `mode: "force"`. Exported + label-
 *  parameterized so the lockfile parser re-validates the consented policy with the SAME rules (no drift). */
export function parseLaunchPolicy(where: string, raw: unknown, errors: string[]): ToolLaunchPolicy | null {
  if (!isPlainObject(raw)) {
    errors.push(`${where}: must be an object { env?, args?, denyArgs?, mode }`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k !== "env" && k !== "args" && k !== "denyArgs" && k !== "mode" && k !== "configArg" && k !== "scrubEnv") errors.push(`${where}: unknown field '${k}'`);
  }
  if (raw.mode !== "force") errors.push(`${where}.mode: must be "force" (the only supported mode)`);

  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env)) {
      errors.push(`${where}.env: must be a map of ENV_NAME → value`);
    } else {
      const keys = Object.keys(raw.env);
      if (keys.length > MAX_LIST) errors.push(`${where}.env: too many entries`);
      const acc: Record<string, string> = {};
      // canonical (sorted) key order so an equivalent policy hashes + serializes identically (stable fingerprint).
      for (const k of keys.slice().sort()) {
        if (!ENV_KEY_RE.test(k)) { errors.push(`${where}.env: '${k}' is not a valid env var name`); continue; }
        if (isDangerousEnvKey(k)) { errors.push(`${where}.env: '${k}' is not allowed (a loader/exec-hijacking var must not be force-set)`); continue; }
        const v = (raw.env as Record<string, unknown>)[k];
        if (typeof v !== "string" || v.length > MAX_STR || v.includes("\0") || CONTROL_RE.test(v)) {
          errors.push(`${where}.env.${k}: must be a control-free string`); continue;
        }
        acc[k] = v;
      }
      if (Object.keys(acc).length > 0) env = acc;
    }
  }

  let args: string[] | undefined;
  if (raw.args !== undefined) args = parseArgvVector(`${where}.args`, raw.args, errors) ?? undefined;

  let denyArgs: string[] | undefined;
  if (raw.denyArgs !== undefined) {
    const d = parseArgvVector(`${where}.denyArgs`, raw.denyArgs, errors) ?? undefined;
    if (d) {
      if (new Set(d).size !== d.length) errors.push(`${where}.denyArgs: must not contain duplicates`);
      denyArgs = d;
    }
  }

  // spec 270/271 — configArg: a single flag the launcher prepends with the resolved config path. A flag string
  // (starts with '-'), control-free, capped.
  let configArg: string | undefined;
  if (raw.configArg !== undefined) {
    const c = raw.configArg;
    if (typeof c !== "string" || c.length === 0 || c.length > MAX_STR || c.includes("\0") || CONTROL_RE.test(c) || !c.startsWith("-")) {
      errors.push(`${where}.configArg: must be a control-free flag string starting with '-'`);
    } else {
      configArg = c;
    }
  }

  // spec 271 — scrubEnv: exact env var names the launcher strips from the child env. Valid env names, capped, deduped.
  let scrubEnv: string[] | undefined;
  if (raw.scrubEnv !== undefined) {
    if (!Array.isArray(raw.scrubEnv) || raw.scrubEnv.length === 0) {
      errors.push(`${where}.scrubEnv: must be a non-empty list of env var names`);
    } else if (raw.scrubEnv.length > MAX_LIST) {
      errors.push(`${where}.scrubEnv: too many entries`);
    } else {
      const acc: string[] = [];
      for (const k of raw.scrubEnv) {
        if (typeof k !== "string" || !ENV_KEY_RE.test(k)) { errors.push(`${where}.scrubEnv: '${String(k)}' is not a valid env var name`); continue; }
        if (!acc.includes(k)) acc.push(k);
      }
      if (acc.length > 0) scrubEnv = acc.slice().sort();
    }
  }

  // "non-trivial" is checked on the PARSED result (not raw presence): a `{ env: {} }` that parsed to nothing must
  // fail HERE — consistently with the lockfile re-parse — rather than yield a policy the lock later rejects.
  if (!env && !args && !denyArgs && !configArg && !scrubEnv) errors.push(`${where}: must declare at least one of env, args, denyArgs, configArg, or scrubEnv`);
  if (errors.some((e) => e.startsWith(where))) return null;
  return { ...(env ? { env } : {}), ...(args ? { args } : {}), ...(denyArgs ? { denyArgs } : {}), ...(configArg ? { configArg } : {}), ...(scrubEnv ? { scrubEnv } : {}), mode: "force" };
}

/** Parse one tool declaration: a version label, an optional detect probe, an optional host-hash gate, and a
 *  non-empty explicit-platform-keyed artifact map. Fail-closed. */
function parseToolDecl(toolName: string, raw: unknown, errors: string[]): ToolDecl | null {
  if (!isPlainObject(raw)) {
    errors.push(`tools.${toolName}: must be an object`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k !== "version" && k !== "versionCommand" && k !== "allowedHostSha256" && k !== "platforms" && k !== "launchPolicy") errors.push(`tools.${toolName}: unknown field '${k}'`);
  }

  const version = raw.version;
  if (typeof version !== "string" || version.length === 0 || version.length > MAX_STR || version.includes("\0") || CONTROL_RE.test(version)) {
    errors.push(`tools.${toolName}.version: required, a non-empty single-line string`);
  }

  let versionCommand: string[] | undefined;
  if (raw.versionCommand !== undefined) {
    versionCommand = parseArgvVector(`tools.${toolName}.versionCommand`, raw.versionCommand, errors) ?? undefined;
  }

  if (raw.allowedHostSha256 !== undefined) validSha256(`tools.${toolName}.allowedHostSha256`, raw.allowedHostSha256, errors);

  const platforms: Record<string, ToolPlatform> = Object.create(null);
  if (!isPlainObject(raw.platforms)) {
    errors.push(`tools.${toolName}.platforms: required, a map of platform-key → { url, sha256, archive? }`);
  } else {
    if (Object.keys(raw.platforms).length === 0) errors.push(`tools.${toolName}.platforms: must declare at least one platform`);
    for (const [key, decl] of Object.entries(raw.platforms)) {
      if (!TOOL_PLATFORM_KEY_SET.has(key)) {
        errors.push(`tools.${toolName}.platforms.${key}: '${key}' is not a known platform key (${TOOL_PLATFORM_KEYS.join(", ")})`);
        continue;
      }
      const p = parseToolPlatform(toolName, key, decl, errors);
      if (p) platforms[key] = p;
    }
  }

  let launchPolicy: ToolLaunchPolicy | undefined;
  if (raw.launchPolicy !== undefined) launchPolicy = parseLaunchPolicy(`tools.${toolName}.launchPolicy`, raw.launchPolicy, errors) ?? undefined;

  return {
    version: version as string,
    ...(versionCommand ? { versionCommand } : {}),
    ...(typeof raw.allowedHostSha256 === "string" ? { allowedHostSha256: raw.allowedHostSha256 } : {}),
    platforms: { ...platforms } as Partial<Record<ToolPlatformKey, ToolPlatform>>,
    ...(launchPolicy ? { launchPolicy } : {}),
  };
}

/** Parse the optional top-level `tools` map: tool-name → declaration. Built on a null-proto accumulator. */
function parseTools(raw: unknown, errors: string[]): Record<string, ToolDecl> {
  const out: Record<string, ToolDecl> = Object.create(null);
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    errors.push("tools: when present, a map of tool-name → declaration");
    return {};
  }
  if (Object.keys(raw).length > MAX_LIST) {
    errors.push("tools: too many entries");
    return {};
  }
  for (const [name, decl] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) {
      errors.push(`tools.${name}: '${name}' is not a valid tool name (lowercase kebab-case)`);
      continue;
    }
    const d = parseToolDecl(name, decl, errors);
    if (d) out[name] = d;
  }
  return { ...out };
}

/** spec 284 — parse one DATA platform's pinned artifact: { url (https), sha256 }. Archive is rejected (single-file v1). */
function parseDataPlatform(where: string, raw: unknown, errors: string[]): DataPlatform | null {
  if (!isPlainObject(raw)) {
    errors.push(`${where}: must be an object { url, sha256 }`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k === "archive") errors.push(`${where}: archive data artifacts are not supported in v1 (single-file only)`);
    else if (k !== "url" && k !== "sha256") errors.push(`${where}: unknown field '${k}'`);
  }
  const urlOk = validHttpsUrl(`${where}.url`, raw.url, errors);
  const shaOk = validSha256(`${where}.sha256`, raw.sha256, errors);
  if (!urlOk || !shaOk || errors.some((e) => e.startsWith(where))) return null;
  return { url: raw.url as string, sha256: raw.sha256 as string };
}

/** spec 284 — parse one DATA declaration: a version label, optional fileName, and EITHER a single {url,sha256} OR a
 *  per-platform `platforms` map (mutually exclusive). Archive bundles are rejected (single-file v1). Fail-closed. */
function parseDataDecl(dataName: string, raw: unknown, errors: string[]): DataDecl | null {
  const w = `data.${dataName}`;
  if (!isPlainObject(raw)) {
    errors.push(`${w}: must be an object`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k === "archive") errors.push(`${w}: archive data artifacts are not supported in v1 (single-file only)`);
    else if (k !== "version" && k !== "fileName" && k !== "url" && k !== "sha256" && k !== "platforms") errors.push(`${w}: unknown field '${k}'`);
  }

  const version = raw.version;
  if (typeof version !== "string" || version.length === 0 || version.length > MAX_STR || version.includes("\0") || CONTROL_RE.test(version)) {
    errors.push(`${w}.version: required, a non-empty single-line string`);
  }

  let fileName: string | undefined;
  if (raw.fileName !== undefined) {
    if (typeof raw.fileName !== "string" || raw.fileName.length > MAX_STR || !PATH_SEGMENT_RE.test(raw.fileName)) {
      errors.push(`${w}.fileName: must be a single path segment (no separators, no controls)`);
    } else fileName = raw.fileName;
  }

  const hasSingle = raw.url !== undefined || raw.sha256 !== undefined;
  const hasPlatforms = raw.platforms !== undefined;
  let single: DataPlatform | undefined;
  let platforms: Record<string, DataPlatform> | undefined;
  if (hasSingle && hasPlatforms) {
    errors.push(`${w}: declare EITHER a single { url, sha256 } OR { platforms }, not both`);
  } else if (hasSingle) {
    single = parseDataPlatform(w, { url: raw.url, sha256: raw.sha256 }, errors) ?? undefined;
  } else if (hasPlatforms) {
    if (!isPlainObject(raw.platforms)) {
      errors.push(`${w}.platforms: a map of platform-key → { url, sha256 }`);
    } else {
      if (Object.keys(raw.platforms).length === 0) errors.push(`${w}.platforms: must declare at least one platform`);
      platforms = Object.create(null);
      for (const [key, decl] of Object.entries(raw.platforms)) {
        if (!TOOL_PLATFORM_KEY_SET.has(key)) {
          errors.push(`${w}.platforms.${key}: '${key}' is not a known platform key (${TOOL_PLATFORM_KEYS.join(", ")})`);
          continue;
        }
        const p = parseDataPlatform(`${w}.platforms.${key}`, decl, errors);
        if (p) platforms![key] = p;
      }
    }
  } else {
    errors.push(`${w}: must declare a single { url, sha256 } or a per-platform { platforms }`);
  }

  if (errors.some((e) => e.startsWith(w))) return null;
  return {
    version: version as string,
    ...(fileName ? { fileName } : {}),
    ...(single ? { single } : {}),
    ...(platforms ? { platforms: { ...platforms } as Partial<Record<ToolPlatformKey, DataPlatform>> } : {}),
  };
}

/** spec 284 — parse the optional top-level `data` map: data-name → declaration. Mirrors parseTools. */
function parseData(raw: unknown, errors: string[]): Record<string, DataDecl> {
  const out: Record<string, DataDecl> = Object.create(null);
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    errors.push("data: when present, a map of data-name → declaration");
    return {};
  }
  if (Object.keys(raw).length > MAX_LIST) {
    errors.push("data: too many entries");
    return {};
  }
  for (const [name, decl] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) {
      errors.push(`data.${name}: '${name}' is not a valid data name (lowercase kebab-case)`);
      continue;
    }
    const d = parseDataDecl(name, decl, errors);
    if (d) out[name] = d;
  }
  return { ...out };
}

/** spec 289 — validate an OPTIONAL candidate-binary-name list, the SAME contract for the manifest AND the lockfile
 *  (codex MEDIUM: the lock must be as fail-closed/bounded as the manifest). Dedicated exec-name charset (NOT the
 *  plugin-key rule): letters/digits/dot/underscore/hyphen, no path separator, no control chars. Cap 8, dedupe
 *  order-preserving, per-entry length ≤128, `[]`/omitted ⇒ undefined. A malformed/over-cap entry pushes an error
 *  (the caller fails closed). */
export function normalizeCandidateNames(raw: unknown, where: string, errors: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) { errors.push(`${where}: must be an array of candidate binary names`); return undefined; }
  if (raw.length === 0) return undefined; // [] == omitted
  const seen = new Set<string>();
  const acc: string[] = [];
  for (const n of raw) {
    if (typeof n !== "string" || n.length > 128 || !EXEC_NAME_RE.test(n)) {
      errors.push(`${where}: '${String(n)}' must be a bare executable name (${EXEC_NAME_RE.source}), no path separator, ≤128 chars`);
      continue;
    }
    if (!seen.has(n)) { seen.add(n); acc.push(n); }
  }
  if (acc.length > MAX_EXTERNAL_NAMES) { errors.push(`${where}: at most ${MAX_EXTERNAL_NAMES} candidates`); return undefined; }
  return acc.length > 0 ? acc : undefined;
}

/** spec 285 — parse one external-tool declaration: optional detect argv, a per-PM install ARGV map (≥1; never a
 *  shell string), and required `manual` guidance. Fail-closed. */
function parseExternalToolDecl(toolName: string, raw: unknown, errors: string[]): ExternalToolDecl | null {
  const w = `externalTools.${toolName}`;
  if (!isPlainObject(raw)) {
    errors.push(`${w}: must be an object { detect?, install, manual }`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k !== "names" && k !== "detect" && k !== "install" && k !== "manual") errors.push(`${w}: unknown field '${k}'`);
  }

  const names = normalizeCandidateNames(raw.names, `${w}.names`, errors); // spec 289

  let detect: string[] | undefined;
  if (raw.detect !== undefined) detect = parseArgvVector(`${w}.detect`, raw.detect, errors) ?? undefined;

  const install: Record<string, ExternalToolInstall> = Object.create(null);
  if (!isPlainObject(raw.install)) {
    errors.push(`${w}.install: required, a map of package-manager → { argv }`);
  } else {
    if (Object.keys(raw.install).length === 0) errors.push(`${w}.install: must declare at least one package manager`);
    for (const [pm, cmd] of Object.entries(raw.install)) {
      if (!PACKAGE_MANAGER_SET.has(pm)) {
        errors.push(`${w}.install.${pm}: '${pm}' is not a known package manager (${PACKAGE_MANAGERS.join(", ")})`);
        continue;
      }
      if (typeof cmd === "string") {
        errors.push(`${w}.install.${pm}: must be { argv: [...] } (a structured argv, NEVER a shell string)`);
        continue;
      }
      if (!isPlainObject(cmd) || Object.keys(cmd).some((k) => k !== "argv")) {
        errors.push(`${w}.install.${pm}: must be an object { argv }`);
        continue;
      }
      const argv = parseArgvVector(`${w}.install.${pm}.argv`, cmd.argv, errors);
      if (!argv) continue;
      if (argv.length === 0) { errors.push(`${w}.install.${pm}.argv: must be a non-empty argv`); continue; }
      install[pm] = { argv };
    }
  }

  const manual = raw.manual;
  if (typeof manual !== "string" || manual.trim().length === 0 || manual.length > MAX_STR || manual.includes("\0") || CONTROL_RE.test(manual)) {
    errors.push(`${w}.manual: required, a non-empty single-line guidance string (or URL)`);
  }

  if (errors.some((e) => e.startsWith(w))) return null;
  return {
    ...(names ? { names } : {}),
    ...(detect ? { detect } : {}),
    install: { ...install } as Partial<Record<PackageManager, ExternalToolInstall>>,
    manual: manual as string,
  };
}

/** spec 285 — parse the optional top-level `externalTools` map: tool-name → declaration. Mirrors parseTools. */
function parseExternalTools(raw: unknown, errors: string[]): Record<string, ExternalToolDecl> {
  const out: Record<string, ExternalToolDecl> = Object.create(null);
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    errors.push("externalTools: when present, a map of tool-name → declaration");
    return {};
  }
  if (Object.keys(raw).length > MAX_LIST) {
    errors.push("externalTools: too many entries");
    return {};
  }
  for (const [name, decl] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) {
      errors.push(`externalTools.${name}: '${name}' is not a valid tool name (lowercase kebab-case)`);
      continue;
    }
    const d = parseExternalToolDecl(name, decl, errors);
    if (d) out[name] = d;
  }
  return { ...out };
}

/** Parse one `name@range` dependency string against the plugin's own name; null on a malformed value. */
function parseDep(raw: unknown, index: number, selfName: string | null, errors: string[]): PluginDep | null {
  if (typeof raw !== "string") {
    errors.push(`dependencies[${index}]: must be a string like 'name@range'`);
    return null;
  }
  if (raw.length > MAX_STR) {
    errors.push(`dependencies[${index}]: too long`);
    return null;
  }
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) {
    errors.push(`dependencies[${index}]: '${raw}' must be 'name@range' (e.g. 'some-base-plugin@^1')`);
    return null;
  }
  const name = raw.slice(0, at);
  const range = raw.slice(at + 1);
  if (!NAME_RE.test(name)) {
    errors.push(`dependencies[${index}]: '${name}' is not a valid plugin name (lowercase kebab-case)`);
    return null;
  }
  if (range.trim().length === 0 || CONTROL_RE.test(range)) {
    errors.push(`dependencies[${index}]: '${name}' has an empty or invalid version range`);
    return null;
  }
  if (selfName !== null && name === selfName) {
    errors.push(`dependencies[${index}]: a plugin cannot depend on itself ('${name}')`);
    return null;
  }
  return { name, range };
}

/**
 * Validate the `runtimes` array → a deduped Runtime[] (pushes errors for unknowns, deferred, duplicates).
 * Returns the accepted supported runtimes (possibly empty). spec 264: `runtimes` is OPTIONAL and MAY be empty —
 * a runtime-agnostic git-hook-only plugin declares none. The "a per-runtime capability needs a runtime" rule is
 * enforced at loadPlugin (which can see blocks/skills/mcp), not here.
 */
function parseRuntimes(raw: unknown, errors: string[]): Runtime[] {
  if (raw === undefined) return []; // omitted → none (git-hook-only)
  if (!Array.isArray(raw)) {
    errors.push(`runtimes: must be a list of ${SUPPORTED_RUNTIMES.join(" | ")}`);
    return [];
  }
  if (raw.length > MAX_LIST) {
    errors.push("runtimes: too many entries");
    return [];
  }
  const seen = new Set<string>();
  const out: Runtime[] = [];
  for (const r of raw) {
    if (typeof r !== "string") {
      errors.push(`runtimes: every entry must be a string (one of ${SUPPORTED_RUNTIMES.join(" | ")})`);
      continue;
    }
    if (seen.has(r)) {
      errors.push(`runtimes: '${r}' is listed more than once`);
      continue;
    }
    seen.add(r);
    if ((SUPPORTED_RUNTIMES as readonly string[]).includes(r)) {
      out.push(r as Runtime);
    } else if (DEFERRED_RUNTIMES.has(r)) {
      errors.push(`runtimes: '${r}' is not supported until a later version (v1 = ${SUPPORTED_RUNTIMES.join(" | ")})`);
    } else {
      errors.push(`runtimes: '${r}' is not a known runtime (expected ${SUPPORTED_RUNTIMES.join(" | ")})`);
    }
  }
  return out;
}

/** Validate a contained, payload-relative path that must name a FILE (not a directory — no trailing '/'). */
function validContainedFile(label: string, raw: unknown, errors: string[]): boolean {
  if (!validContainedPath(label, raw, errors)) return false;
  if (typeof raw === "string" && raw.endsWith("/")) {
    errors.push(`${label}: must name a file, not a directory (no trailing '/')`);
    return false;
  }
  return true;
}

function parseViewActions(viewId: string, raw: unknown, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`views.${viewId}.actions: must be a list of action names`);
    return [];
  }
  if (raw.length > MAX_LIST) {
    errors.push(`views.${viewId}.actions: too many entries`);
    return [];
  }
  const out: string[] = [];
  for (const a of raw) {
    if (typeof a !== "string" || a.length === 0 || a.length > MAX_STR || a.includes("\0") || CONTROL_RE.test(a) || !VIEW_ACTION_RE.test(a)) {
      errors.push(`views.${viewId}.actions: every action must be a non-empty, control-free identifier`);
      continue;
    }
    if (out.includes(a)) errors.push(`views.${viewId}.actions: '${a}' is listed more than once`);
    else out.push(a);
  }
  return out;
}

function parseViewDecl(raw: unknown, index: number, errors: string[]): ViewDecl | null {
  const where = `views[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${where}: must be an object`);
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k !== "id" && k !== "title" && k !== "surface" && k !== "entry" && k !== "icon" && k !== "fleet" && k !== "actions") {
      errors.push(`${where}: unknown field '${k}'`);
    }
  }
  const id = raw.id;
  if (typeof id !== "string" || !NAME_RE.test(id)) errors.push(`${where}.id: required, lowercase kebab-case`);
  const label = typeof id === "string" && id.length > 0 ? id : String(index);
  const title = raw.title;
  if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_STR || title.includes("\0") || CONTROL_RE.test(title)) {
    errors.push(`${where}.title: required, a non-empty single-line string`);
  }
  const surface = raw.surface;
  if (typeof surface !== "string" || !VIEW_SURFACE_SET.has(surface)) errors.push(`${where}.surface: must be one of ${VIEW_SURFACES.join(", ")}`);
  validContainedFile(`${where}.entry`, raw.entry, errors);
  if (typeof raw.entry === "string" && !raw.entry.endsWith(".html")) errors.push(`${where}.entry: must point to a .html file`);
  let icon: string | undefined;
  if (raw.icon !== undefined) {
    if (validContainedFile(`${where}.icon`, raw.icon, errors)) icon = raw.icon as string;
  }
  const fleet = raw.fleet;
  if (typeof fleet !== "string" || !VIEW_FLEET_SCOPE_SET.has(fleet)) errors.push(`${where}.fleet: must be ${VIEW_FLEET_SCOPES.join(" | ")}`);
  const actions = parseViewActions(label, raw.actions, errors);
  if (errors.some((e) => e.startsWith(where) || e.startsWith(`views.${label}.`))) return null;
  return {
    id: id as string,
    title: (title as string).trim(),
    surface: surface as ViewSurface,
    entry: raw.entry as string,
    ...(icon ? { icon } : {}),
    fleet: fleet as ViewFleetScope,
    actions,
  };
}

function parseViews(raw: unknown, errors: string[]): ViewDecl[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("views: when present, a list of view declarations");
    return [];
  }
  if (raw.length > MAX_LIST) {
    errors.push("views: too many entries");
    return [];
  }
  const seen = new Set<string>();
  const out: ViewDecl[] = [];
  raw.forEach((v, i) => {
    const parsed = parseViewDecl(v, i, errors);
    if (!parsed) return;
    if (seen.has(parsed.id)) {
      errors.push(`views[${i}].id: '${parsed.id}' is listed more than once`);
      return;
    }
    seen.add(parsed.id);
    out.push(parsed);
  });
  return out;
}

/** Parse the optional top-level `config` (spec 270): { file, schemaFile? }, both contained payload FILES. */
function parseConfigDecl(raw: unknown, errors: string[]): ConfigDecl | null {
  if (!isPlainObject(raw)) {
    errors.push("config: when present, an object { file, schemaFile? }");
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (k !== "file" && k !== "schemaFile") errors.push(`config: unknown field '${k}'`);
  }
  const fileOk = validContainedFile("config.file", raw.file, errors);
  let schemaFile: string | undefined;
  if (raw.schemaFile !== undefined) {
    if (validContainedFile("config.schemaFile", raw.schemaFile, errors)) schemaFile = raw.schemaFile as string;
    else return null;
  }
  if (!fileOk) return null;
  return { file: raw.file as string, ...(schemaFile ? { schemaFile } : {}) };
}

/**
 * Parse + validate a Tachyon plugin manifest from its raw JSON text. Fail-closed and
 * error-accumulating: collects every problem into `errors` and only returns a `manifest`
 * when the input is wholly valid. Never throws.
 */
export function loadManifest(rawJson: string): ManifestParseResult {
  const errors: string[] = [];

  if (typeof rawJson !== "string" || Buffer.byteLength(rawJson, "utf8") > MAX_MANIFEST_BYTES) {
    return { errors: [`manifest: input is empty or exceeds ${MAX_MANIFEST_BYTES} bytes`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!isPlainObject(parsed)) {
    return { errors: ["manifest: must be a JSON object"] };
  }

  // unknown top-level fields fail closed (catches typos; a v2-only field correctly fails on a v1 install).
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_FIELDS.has(key)) errors.push(`unknown field '${key}'`);
  }

  // name
  const name = parsed.name;
  const nameOk = typeof name === "string" && name.length <= MAX_STR && NAME_RE.test(name);
  if (!nameOk) errors.push("name: required, lowercase kebab-case (e.g. 'example-plugin', 'some-base-plugin')");

  // version
  const version = parsed.version;
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    errors.push("version: required, semver 'major.minor.patch' (e.g. '1.2.0')");
  }

  // description
  const description = parsed.description;
  if (typeof description !== "string" || description.trim().length === 0 || description.length > MAX_STR || CONTROL_RE.test(description)) {
    errors.push("description: required, a non-empty single-line string");
  }

  // runtimes
  const runtimes = parseRuntimes(parsed.runtimes, errors);
  const declared = new Set<Runtime>(runtimes);

  // dependencies (optional)
  const dependencies: PluginDep[] = [];
  if (parsed.dependencies !== undefined) {
    if (!Array.isArray(parsed.dependencies)) {
      errors.push("dependencies: must be a list of 'name@range' strings");
    } else if (parsed.dependencies.length > MAX_LIST) {
      errors.push("dependencies: too many entries");
    } else {
      const seenDep = new Set<string>();
      parsed.dependencies.forEach((d, i) => {
        const dep = parseDep(d, i, nameOk ? (name as string) : null, errors);
        if (!dep) return;
        if (seenDep.has(dep.name)) {
          errors.push(`dependencies[${i}]: '${dep.name}' is listed more than once`);
          return;
        }
        seenDep.add(dep.name);
        dependencies.push(dep);
      });
    }
  }

  // blocks — OPTIONAL (spec 251): a plugin may ship hooks for some/all/none of its declared runtimes (a
  // skills-only plugin has no blocks; loadPlugin enforces "at least one capability" since it can see the
  // skills/ payload). When present, each key must be a DECLARED runtime (no orphan/unknown/deferred/proto
  // keys) and each path a contained relative path. Built on a null-proto object as defense-in-depth.
  const blocks: Record<string, string> = Object.create(null);
  if (parsed.blocks !== undefined) {
    if (!isPlainObject(parsed.blocks)) {
      errors.push("blocks: when present, a map of runtime → block directory path");
    } else {
      for (const [key, path] of Object.entries(parsed.blocks)) {
        if (!declared.has(key as Runtime)) {
          // covers gemini, an unknown runtime, __proto__/constructor, and a supported-but-undeclared key.
          errors.push(`blocks.${key}: '${key}' is not a declared runtime (declared: ${runtimes.join(", ") || "none"})`);
          continue;
        }
        if (validBlockPath(key, path, errors)) blocks[key] = path as string;
      }
    }
  }

  // gitHooks — OPTIONAL, runtime-agnostic (spec 264). v1: only `pre-commit`; leaf is a contained payload
  // script or an argv vector. loadPlugin counts a git-hook as a capability.
  const gitHooks = parseGitHooks(parsed.gitHooks, errors);

  // tools — OPTIONAL, author-pinned per-platform binaries (spec 265). Fetch+verify+content-address-install,
  // human-consented; referenced by a git-hook argv leaf's `${tool:<name>}`. Empty when omitted.
  const tools = parseTools(parsed.tools, errors);

  // data — OPTIONAL, author-pinned non-executable DATA artifacts (spec 284). Fetch+verify+content-address-install
  // read-only; resolved by a skill via the `_tachyon-data` shim. Empty when omitted.
  const data = parseData(parsed.data, errors);

  // externalTools — OPTIONAL external system tools the plugin needs (spec 285): declare + detect + assisted-install.
  const externalTools = parseExternalTools(parsed.externalTools, errors);

  // config — OPTIONAL human-facing config the plugin ships (spec 270): a payload config file + optional schema file.
  let config: ConfigDecl | undefined;
  if (parsed.config !== undefined) config = parseConfigDecl(parsed.config, errors) ?? undefined;

  // docsUrl — OPTIONAL https docs link surfaced as the card's "Docs" button (spec 270). https-only (no command:/file:).
  if (parsed.docsUrl !== undefined) validHttpsUrl("docsUrl", parsed.docsUrl, errors);

  // views — OPTIONAL runtime-agnostic UI surfaces (spec 349). loadPlugin counts these as a capability.
  const views = parseViews(parsed.views, errors);

  if (errors.length > 0) return { errors };

  return {
    manifest: {
      name: name as string,
      version: version as string,
      description: (description as string).trim(),
      runtimes,
      dependencies,
      blocks: { ...blocks } as Partial<Record<Runtime, string>>, // copy off the null-proto object into a normal one
      gitHooks,
      tools,
      data,
      externalTools,
      ...(config ? { config } : {}),
      ...(typeof parsed.docsUrl === "string" ? { docsUrl: parsed.docsUrl } : {}),
      views,
    },
    errors: [],
  };
}

export interface CompatResult {
  /** declared runtimes that ARE present in the workspace → the install targets. */
  installable: Runtime[];
  /** declared runtimes NOT present in the workspace → greyed-out / honest-degradation in the UI. */
  missingFromWorkspace: Runtime[];
}

/**
 * Resolve a plugin's install compatibility against the runtimes actually present in a workspace.
 * `installable` is what the engine will wire; an empty `installable` means nothing to do (the UI
 * should say so rather than report a phantom success).
 */
export function resolveCompat(manifest: PluginManifest, presentRuntimes: ReadonlySet<string>): CompatResult {
  const installable: Runtime[] = [];
  const missingFromWorkspace: Runtime[] = [];
  for (const rt of manifest.runtimes) {
    if (presentRuntimes.has(rt)) installable.push(rt);
    else missingFromWorkspace.push(rt);
  }
  return { installable, missingFromWorkspace };
}
