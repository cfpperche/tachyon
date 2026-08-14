/**
 * spec 250 Step 3-4 — the plugin materialization engine (I/O), runtime-generic. Reads a plugin from disk,
 * plans an install (a READ-ONLY preview = the security surface shown before consent), applies it (writes each
 * runtime's config + copies the payload + records the lockfile), and reverses it on remove (un-merging exactly
 * what was written + surfacing conservative orphans). Wires every runtime the plugin declares AND the
 * workspace has, dispatching through a per-runtime adapter registry (claude + codex in v1).
 *
 * Trust + safety model (per the Step-3 review):
 *  - TWO-PHASE: preview* never write; apply* re-derive the preview and refuse if the workspace changed since
 *    consent (a `fingerprint` TOCTOU guard), plus a per-file lost-update check before each write.
 *  - FAIL-CLOSED reads: a corrupt lockfile or unparseable settings is an ERROR (never silently empty).
 *  - UNTRUSTED payload: preflighted (no symlinks/special files; bounded) AND re-checked on a STAGED copy
 *    against the consented hash before promotion (closes the preflight→copy TOCTOU).
 *  - TRANSACTIONAL install order: payload → lockfile → settings (settings activates hooks last).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadManifest, resolveCompat, SUPPORTED_RUNTIMES, type PluginManifest, type Runtime, type ViewDecl } from "@tachyon/engine/plugins/manifest.js";
import {
  mergeHooks,
  removeHooks,
  parseOwnedHooks,
  normalizeHookSettings,
  PLUGIN_ROOT_PLACEHOLDER,
  type HooksBlock,
  type HookSettings,
  type OwnedHooks,
  type BlockParseResult,
} from "@tachyon/engine/plugins/adapters/hooks.js";
import { parseClaudeHooksBlock } from "@tachyon/engine/plugins/adapters/claude.js";
import { parseCodexHooksBlock } from "@tachyon/engine/plugins/adapters/codex.js";
import { parseGrokHooksBlock } from "@tachyon/engine/plugins/adapters/grok.js";
import { readFile, atomicWrite } from "./fsx.js";
import { PLUGIN_PAYLOAD_ROOT, PLUGIN_SKILLS_DIR } from "@tachyon/engine/plugins/paths.js";
import { MCP_SERVER_NAME, readMcpConfig, renderMcp, setMcpServer, setMcpFromRemoval, removeMcpServerText, currentMcp, mcpRepEquals, writeMcpConfig } from "./mcpConfig.js";
import { parseSource, parseSemverTag, compareSemver, rewriteRef } from "./source.js";
import { fetchSource, defaultGitRun, resolveLatestSemverTag, type GitRun } from "./fetcher.js";
import { parseSkillFrontmatter } from "./skill.js";
import { validateEntryHtml } from "./entryHtmlValidator.js";
import { loadMcpPayload, type McpServer } from "@tachyon/engine/plugins/mcp.js";
import {
  argvWrapperScript,
  GitHookStore,
  GITHOOKS_REL,
  DISPATCHER_TEMPLATE_VERSION,
  readDispatcherTemplateVersion,
  type EventEntry,
} from "./gitHookRegistry.js";
import { GitRepo } from "./gitRepo.js";
import { gatherGitHookState, type GitHookState, type PriorHookIdentity } from "./gitHookState.js";
import { gatherToolPlan, type ToolPlan, type ToolPlanItem } from "./toolPlan.js";
import { gatherDataPlan, type DataPlan, type DataPlanItem } from "./dataPlan.js";
import { detectExternalTool, buildAssistedInstall, materializeExternalResolver } from "./externalTool.js";
import { isTrustedExecPath } from "./toolProvisioning.js";
import { provisionTools, provisionData, type ProvisionProgressFn } from "./toolProvisionRun.js";
import { resolveToolPlaceholders, containsToolPlaceholder } from "./toolPlaceholder.js";
import { physicalToolKey, toolReferenceCounts, physicalDataKey, dataReferenceCounts, type ToolLock, type DataLock, type ExternalToolReqLock, type LauncherLock } from "@tachyon/engine/plugins/lockfile.js";
import { dependencyStates, type DependencyState } from "./pluginDeps.js";
import { agentEntriesOfLkg, readConfigLkg } from "@tachyon/engine/config/configLkg.js";
import { runtimeOf } from "@tachyon/shared/resume/adapters.js";
import { AppliedStateError, AppliedStateStore, type ContributionRef } from "./appliedState.js";

/** spec 265 — the repo-root-RELATIVE launcher path baked into a resolved git-hook leaf (clone-safe; git runs
 *  hooks with cwd = the repo top-level). The launcher itself derives the workspace from its own location. */
const LAUNCHER_REL = ".tachyon/bin/_tachyon-tool";
import {
  parseLockfile,
  serializeLockfile,
  emptyLockfile,
  LOCKFILE_REL_PATH,
  type Lockfile,
  type PluginLock,
  type MaterializedTarget,
  type SourceLock,
  type IntegrityLock,
  type GitHookLock,
} from "@tachyon/engine/plugins/lockfile.js";

export const MANIFEST_REL = "tachyon-plugin.json";
const HOOKS_FILE = "hooks.json"; // inside a runtime block dir
const SKILLS_DIR = PLUGIN_SKILLS_DIR; // spec 251 — the plugin's neutral skills payload root
const SKILL_FILE = "SKILL.md"; // inside each skills/<name>/ dir
const MCP_FILE = "mcp.json"; // spec 254 — the plugin's neutral MCP-server payload (at the plugin root)
export const PAYLOAD_ROOT = PLUGIN_PAYLOAD_ROOT;

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_PAYLOAD_FILES = 5000;
const MAX_PAYLOAD_DEPTH = 32;

/** Per-runtime materialization spec: where its hook config + skills live + how to parse its native block. */
interface AdapterSpec {
  settingsRel: string;
  parseBlock: (raw: string) => BlockParseResult;
  /** spec 251 — the runtime's PROJECT-level skills dir (workspace-relative, posix), or null if the runtime
   *  has no skills loader (then a plugin's skills are skipped for it). Verified vs official docs:
   *  claude reads `.claude/skills/`, codex reads `.agents/skills/`. */
  skillsRel: string | null;
  /** spec 254 — the runtime's PROJECT-level MCP config file (workspace-relative, posix), or null if the
   *  runtime has no MCP loader (then a plugin's MCP servers are skipped for it). Verified vs official docs:
   *  claude `.mcp.json` (mcpServers), codex `.codex/config.toml` (`[mcp_servers.<name>]`, trusted project). */
  mcpRel: string | null;
}
const ADAPTERS: Record<Runtime, AdapterSpec> = {
  claude: { settingsRel: ".claude/settings.json", parseBlock: parseClaudeHooksBlock, skillsRel: ".claude/skills", mcpRel: ".mcp.json" },
  codex: { settingsRel: ".codex/hooks.json", parseBlock: parseCodexHooksBlock, skillsRel: ".agents/skills", mcpRel: ".codex/config.toml" },
  // t-2f99e7 — guide-measured layout (see adapters/grok.ts). mcpRel is null: Grok's project MCP
  // schema is not the codex codec; hooks + skills install without inventing a wrong MCP path.
  grok: { settingsRel: ".grok/hooks/tachyon-plugins.json", parseBlock: parseGrokHooksBlock, skillsRel: ".grok/skills", mcpRel: null },
};

/**
 * spec 263 — the universe of RUNTIME ancestor dirs an install may create, derived from the adapter layout:
 * every directory that is an ancestor of a settings/skills/mcp destination (e.g. `.claude`, `.claude/skills`,
 * `.codex`, `.agents`, `.agents/skills`). The payload root (`.tachyon/…`) is deliberately EXCLUDED — it is
 * Tachyon's own workspace-state dir and is never rmdir'd on uninstall. Used to (a) pick which ancestors to
 * record at install and (b) validate recorded ancestors before a non-recursive `rmdir` at uninstall, so a
 * corrupted lockfile can never make remove `rmdir` an arbitrary path.
 */
function runtimeAncestorUniverse(): ReadonlySet<string> {
  const u = new Set<string>();
  const addAncestorsOf = (rel: string | null): void => {
    if (!rel) return;
    let d = path.posix.dirname(rel);
    while (d && d !== "." && d !== "/") {
      u.add(d);
      d = path.posix.dirname(d);
    }
  };
  for (const rt of SUPPORTED_RUNTIMES) {
    const a = ADAPTERS[rt];
    addAncestorsOf(a.settingsRel); // a file → its ancestor dirs (e.g. `.claude`)
    addAncestorsOf(a.mcpRel); // `.mcp.json` → none (root); `.codex/config.toml` → `.codex`
    if (a.skillsRel) {
      u.add(a.skillsRel); // the skills DIR itself is a created ancestor of each `<skillsRel>/<name>` dest
      addAncestorsOf(a.skillsRel); // …plus its own ancestors (e.g. `.agents`)
    }
  }
  return u;
}
const RUNTIME_ANCESTORS = runtimeAncestorUniverse();

/** The runtime ancestor dirs (from RUNTIME_ANCESTORS) that are ancestors of any of `destPaths` AND do NOT yet
 *  exist on disk — i.e. exactly the dirs activation is about to create. Deduped, sorted (lexicographic; the
 *  caller re-sorts deepest-first at removal). Computed from LIVE disk state, so it is always the true
 *  "did-not-pre-exist" set regardless of any drift the fingerprint guard already rejects. */
function computeCreatedAncestors(workspaceRoot: string, destPaths: string[]): string[] {
  const created = new Set<string>();
  for (const dest of destPaths) {
    let d = path.posix.dirname(dest);
    while (d && d !== "." && d !== "/") {
      if (RUNTIME_ANCESTORS.has(d) && !fs.existsSync(path.join(workspaceRoot, d))) created.add(d);
      d = path.posix.dirname(d);
    }
  }
  return [...created].sort();
}

// ── fs helpers ──────────────────────────────────────────────────────────────
// `readFile` / `atomicWrite` / `FileRead` live in `fsx.ts` (imported above). `atomicWrite` is re-exported here
// for the spec-263 temp-cleanup invariant test that imports it from the engine.
export { atomicWrite } from "./fsx.js";

function writeSettings(file: string, settings: HookSettings): void {
  if (Object.keys(settings).length > 0) atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
  else fs.rmSync(file, { force: true });
}

interface SettingsRead {
  settings?: HookSettings;
  errors: string[];
}

/** Read a runtime's hook config fail-closed: absent → `{}`; unreadable or invalid → ERROR. */
function readSettings(file: string): SettingsRead {
  const rd = readFile(file);
  if (rd.error) return { errors: [`${path.basename(file)}: ${rd.error}`] };
  if (rd.missing) return { settings: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rd.text as string);
  } catch {
    return { errors: [`${path.basename(file)}: invalid JSON — refusing to overwrite a broken config file`] };
  }
  return normalizeHookSettings(parsed);
}

/** True iff the on-disk config still equals the snapshot the merge was computed from (lost-update guard). */
function settingsUnchanged(file: string, expected: HookSettings): boolean {
  const r = readSettings(file);
  return !!r.settings && JSON.stringify(r.settings) === JSON.stringify(expected);
}

interface LockfileRead {
  lockfile?: Lockfile;
  errors: string[];
}

/** Read the lockfile fail-closed: absent → empty; unreadable or corrupt → ERROR. */
function readLockfile(workspaceRoot: string): LockfileRead {
  const rd = readFile(path.join(workspaceRoot, LOCKFILE_REL_PATH));
  if (rd.error) return { errors: [`${LOCKFILE_REL_PATH}: ${rd.error}`] };
  if (rd.missing) return { lockfile: emptyLockfile(), errors: [] };
  const { lockfile, errors } = parseLockfile(rd.text as string);
  if (!lockfile) return { errors: [`${LOCKFILE_REL_PATH} is corrupt: ${errors.join("; ")}`] };
  return { lockfile, errors: [] };
}

function writeLockfile(workspaceRoot: string, lockfile: Lockfile): void {
  const file = path.join(workspaceRoot, LOCKFILE_REL_PATH);
  if (Object.keys(lockfile.plugins).length > 0) atomicWrite(file, serializeLockfile(lockfile));
  else fs.rmSync(file, { force: true });
}

// ── untrusted payload preflight ─────────────────────────────────────────────

interface PayloadCheck {
  hash: string;
  errors: string[];
}

/** Walk an untrusted plugin dir BEFORE copying: reject symlinks/special files, bound bytes/files/depth, and
 *  accumulate a deterministic content hash (used in the install fingerprint + the staged-copy re-check). */
function preflightPayload(dir: string): PayloadCheck {
  const errors: string[] = [];
  const h = crypto.createHash("sha256");
  let bytes = 0;
  let files = 0;

  const walk = (d: string, depth: number, rel: string): void => {
    if (errors.length > 0) return;
    if (depth > MAX_PAYLOAD_DEPTH) {
      errors.push(`payload exceeds max depth (${MAX_PAYLOAD_DEPTH})`);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      errors.push(`cannot read payload dir: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (errors.length > 0) return;
      const p = path.join(d, ent.name);
      const r = path.posix.join(rel, ent.name);
      if (ent.isSymbolicLink()) {
        errors.push(`payload contains a symlink (not allowed): ${r}`);
        return;
      }
      if (ent.isDirectory()) {
        h.update(`D:${r}\n`);
        walk(p, depth + 1, r);
      } else if (ent.isFile()) {
        if (++files > MAX_PAYLOAD_FILES) {
          errors.push(`payload exceeds max file count (${MAX_PAYLOAD_FILES})`);
          return;
        }
        bytes += fs.statSync(p).size;
        if (bytes > MAX_PAYLOAD_BYTES) {
          errors.push(`payload exceeds max size (${MAX_PAYLOAD_BYTES} bytes)`);
          return;
        }
        h.update(`F:${r}:`);
        h.update(fs.readFileSync(p));
        h.update("\n");
      } else {
        errors.push(`payload contains a special file (not allowed): ${r}`);
        return;
      }
    }
  };

  walk(dir, 0, "");
  return { hash: h.digest("hex"), errors };
}

// ── runtime detection ───────────────────────────────────────────────────────

/**
 * Which plugin runtimes a workspace uses.
 *
 * Project config directories are a valid pre-roster signal for runtimes that read project scope.
 * The resolved roster is the signal for runtimes whose Tachyon config home is agent-private: its
 * LKG is written after a successful config load, before any agent needs to spawn/materialize a home.
 */
export function detectRuntimes(workspaceRoot: string): Set<Runtime> {
  const present = new Set<Runtime>();
  if (fs.existsSync(path.join(workspaceRoot, ".claude"))) present.add("claude");
  if (fs.existsSync(path.join(workspaceRoot, ".codex"))) present.add("codex");
  if (fs.existsSync(path.join(workspaceRoot, ".grok"))) present.add("grok");

  // t-333f68 — a Temporary Grok agent has no roster row and deliberately does not create project
  // `.grok/`, but its canonical live session still has a Tachyon-owned private GROK_HOME. Count that
  // observed activity instead of every runtime the spawn API could hypothetically launch: dismiss/
  // forget owns removal of these homes, so this signal is transient and a workspace that never uses
  // Grok does not acquire an idle plugin block merely because Grok is supported by the product.
  //
  // t-7bc276 — "dismiss/forget owns removal of these homes" was an ASSERTION, not a fact, on the day
  // it was written: nothing removed them, so this scan was the one reader whose answer a dead agent
  // silently changed — one dismissed home kept a workspace classified as a Grok workspace forever.
  // `forgetAgent`'s bridge-runtime-home footprint is what makes the sentence above true, and homes
  // that predate it are reported by `reportOrphanBridgeRuntimeHomes` rather than removed unasked.
  try {
    const bridgeHomes = path.join(workspaceRoot, ".tachyon", "bridge-mcp");
    if (fs.readdirSync(bridgeHomes, { withFileTypes: true }).some((entry) => entry.isDirectory() && entry.name.endsWith(".grok"))) {
      present.add("grok");
    }
  } catch {
    // Absence/unreadability is not evidence that this workspace uses the runtime.
  }
  const supported = new Set<string>(SUPPORTED_RUNTIMES);
  for (const entry of agentEntriesOfLkg(readConfigLkg(workspaceRoot))) {
    if (!entry.cmd) continue;
    const runtime = runtimeOf(entry.cmd);
    if (runtime && supported.has(runtime)) present.add(runtime as Runtime);
  }
  return present;
}

// ── load a plugin from disk ─────────────────────────────────────────────────

/** spec 251 — a skill discovered in the plugin's neutral `skills/` payload (materialized per-runtime later). */
export interface PluginSkill {
  /** the skill id = its source subdir name === its SKILL.md frontmatter `name` (the install dir name). */
  name: string;
  /** the SKILL.md `description` frontmatter (shown in the consent drawer). */
  description: string;
  /** posix-relative dir of the skill within the plugin payload (e.g. "skills/pdf-processing"). */
  dirRel: string;
}

/** spec 264 — a git-hook leaf discovered from the manifest's `gitHooks` declaration (runtime-agnostic). */
export interface PluginGitHook {
  /** the git event (v1: `pre-commit`). */
  event: string;
  /** the leaf's content — a payload script's bytes, or a generated argv wrapper. */
  content: Buffer;
  /** sha256 of `content` (= its `leaves/<hash>` name). */
  contentHash: string;
  /** present when the leaf was declared as an argv vector (for consent/audit). */
  argv?: string[];
  /** payload-relative source path for a script leaf (for the consent file-writes display). */
  srcRel?: string;
}

export interface LoadedPlugin {
  dir: string;
  manifest: PluginManifest;
  /** per-runtime parsed hooks block (one per runtime that ships a block; may be empty for a skills-only plugin). */
  blocks: Partial<Record<Runtime, HooksBlock>>;
  /** per-runtime posix payload root (relative to a workspace). */
  rootRel: Partial<Record<Runtime, string>>;
  /** the plugin's skills (neutral payload), sorted by name; empty when the plugin ships no skills. */
  skills: PluginSkill[];
  /** the plugin's MCP servers (neutral `mcp.json` payload), in declared order; empty when none. */
  mcp: McpServer[];
  /** spec 264 — runtime-agnostic git-hook leaves; empty when the plugin declares none. */
  gitHooks: PluginGitHook[];
  /** spec 349 — runtime-agnostic UI surfaces declared by the plugin; empty when none. */
  views?: ViewDecl[];
}

/** The reproducible provenance of a source-installed plugin — written into the lockfile by applyInstall. */
export interface InstallProvenance {
  source: SourceLock;
  integrity: IntegrityLock;
}

export interface LoadResult {
  plugin?: LoadedPlugin;
  /** present only when loaded via a source-spec — the source+integrity to pin in the lockfile. */
  provenance?: InstallProvenance;
  errors: string[];
}

/**
 * Load a plugin from a remote SOURCE-SPEC: resolve → fetch into the verified cache → loadPlugin. The bridge
 * between the source/fetcher layer and the install engine. The returned `LoadedPlugin.dir` is a cache dir the
 * install then copies into the workspace (committed); `provenance` carries the source + integrity so the
 * lockfile pins a byte-reproducible re-hydrate.
 */
export async function loadPluginFromSource(spec: string, git: GitRun = defaultGitRun, opts: { cacheRoot?: string } = {}): Promise<LoadResult> {
  const parsed = parseSource(spec);
  if (!parsed.source) return { errors: parsed.errors };
  const fetched = await fetchSource(parsed.source, git, opts);
  if (!fetched.dir || !fetched.resolvedCommit || !fetched.payloadHash) return { errors: fetched.errors };
  const loaded = loadPlugin(fetched.dir);
  if (!loaded.plugin) return { errors: loaded.errors };
  const s = parsed.source;
  const provenance: InstallProvenance = {
    source: { type: "git", spec: s.spec, remote: s.remote, ref: s.ref, resolvedCommit: fetched.resolvedCommit, ...(s.subdir ? { subdir: s.subdir } : {}) },
    integrity: { algorithm: "sha256", payload: fetched.payloadHash },
  };
  return { plugin: loaded.plugin, provenance, errors: [] };
}

/**
 * spec 266 — pick the source-spec the update check should EVALUATE. For a plugin pinned to a semver tag, probe
 * the source repo's highest semver tag; if it is strictly higher than the current pin, return the spec rewritten
 * to that higher tag (a still-IMMUTABLE pin — reproducibility preserved). Otherwise (the pin is a branch / HEAD /
 * SHA / non-semver tag, OR no higher tag exists, OR the probe failed) return the original spec verbatim, so the
 * existing exact-ref behavior holds. Fail-closed + non-fatal: never throws, never widens a pin silently — only a
 * current semver-tag pin can be bumped, and only to a higher semver tag. The manifest-version decision stays in
 * `previewUpdate` (a monorepo tag that doesn't change THIS plugin still resolves to up-to-date downstream).
 */
export async function resolveEffectiveUpdateSpec(spec: string, git: GitRun = defaultGitRun): Promise<string> {
  const parsed = parseSource(spec);
  if (!parsed.source) return spec; // unparseable here → let loadPluginFromSource surface the real error
  // `refKind: "named"` covers BOTH branches and tags, and `parseSemverTag` only checks the NAME shape. A branch
  // named `v1.0.0` must not be treated as a tag pin (it would get silently bumped), so eligibility is shape-first…
  if (parsed.source.refKind !== "named" || !parseSemverTag(parsed.source.ref)) return spec; // not a semver-shaped pin
  const latest = await resolveLatestSemverTag(parsed.source, git);
  // …then PROVED: the current ref must exist as a real tag in the repo, else it is a branch (or a deleted tag)
  // and we leave the pin untouched. Only then bump to a strictly higher semver tag.
  if (!latest.tag || !latest.tags.includes(parsed.source.ref) || compareSemver(latest.tag, parsed.source.ref) <= 0) return spec;
  return rewriteRef(spec, latest.tag);
}

/** Read + validate a plugin directory: manifest + each runtime's hooks block (those it ships) + the neutral
 *  `skills/` payload. A plugin must carry AT LEAST ONE capability (hooks and/or skills). Fail-closed. */
export function loadPlugin(pluginDir: string): LoadResult {
  const manifestRead = readFile(path.join(pluginDir, MANIFEST_REL));
  if (manifestRead.error) return { errors: [`${MANIFEST_REL}: ${manifestRead.error}`] };
  if (manifestRead.missing) return { errors: [`no ${MANIFEST_REL} in ${pluginDir}`] };
  const { manifest, errors } = loadManifest(manifestRead.text as string);
  if (!manifest) return { errors };

  const plugin: LoadedPlugin = { dir: pluginDir, manifest, blocks: {}, rootRel: {}, skills: [], mcp: [], gitHooks: [], views: manifest.views ?? [] };

  // hooks — only the runtimes that ship a block (spec 251: blocks are optional/partial).
  for (const rt of Object.keys(manifest.blocks) as Runtime[]) {
    const spec = ADAPTERS[rt];
    const blockRel = manifest.blocks[rt] as string;
    const hooksRead = readFile(path.join(pluginDir, blockRel, HOOKS_FILE));
    if (hooksRead.error) return { errors: [`${rt}/${HOOKS_FILE}: ${hooksRead.error}`] };
    if (hooksRead.missing) return { errors: [`${rt} block '${blockRel}' has no ${HOOKS_FILE}`] };
    const parsed = spec.parseBlock(hooksRead.text as string);
    if (!parsed.hooks) return { errors: parsed.errors.map((e) => `${rt}/${HOOKS_FILE}: ${e}`) };
    plugin.blocks[rt] = parsed.hooks;
    plugin.rootRel[rt] = path.posix.join(PAYLOAD_ROOT, manifest.name, blockRel.replace(/\/+$/, ""));
  }

  // skills — auto-discovered from the neutral `skills/` payload (one per subdir that has a SKILL.md).
  const skillsResult = discoverSkills(pluginDir);
  if (skillsResult.errors.length > 0) return { errors: skillsResult.errors };
  plugin.skills = skillsResult.skills;

  // mcp — auto-discovered from the neutral `mcp.json` payload at the plugin root (absent → no MCP).
  const mcpResult = discoverMcp(pluginDir);
  if (mcpResult.errors.length > 0) return { errors: mcpResult.errors };
  plugin.mcp = mcpResult.servers;

  // git-hooks — from the manifest's `gitHooks` declaration (spec 264). Read each script leaf's bytes (fail-closed
  // on a missing/non-regular file); an argv leaf becomes a generated wrapper.
  const ghResult = discoverGitHooks(pluginDir, manifest);
  if (ghResult.errors.length > 0) return { errors: ghResult.errors };
  plugin.gitHooks = ghResult.gitHooks;

  if (Object.keys(plugin.blocks).length === 0 && plugin.skills.length === 0 && plugin.mcp.length === 0 && plugin.gitHooks.length === 0 && (plugin.views ?? []).length === 0) {
    return { errors: [`${manifest.name}: a plugin must ship at least one capability (a runtime hooks block, a skill, an MCP server, a git-hook, and/or a view)`] };
  }
  // spec 264 — a PER-RUNTIME capability (hooks block / skill / MCP) needs ≥1 declared runtime to land in; only a
  // git-hook is runtime-agnostic. (Blocks already require declared runtimes at the manifest layer; skills/MCP are
  // payload-discovered, so guard them here.)
  if ((plugin.skills.length > 0 || plugin.mcp.length > 0) && manifest.runtimes.length === 0) {
    return { errors: [`${manifest.name}: skills/MCP need at least one declared runtime to install into (only git-hooks are runtime-agnostic)`] };
  }

  return { plugin, errors: [] };
}

/** Discover the manifest's git-hook leaves: a script leaf's payload bytes (must be a REAL regular file — no
 *  symlink escaping the plugin), or a generated argv wrapper. Fail-closed. */
function discoverGitHooks(pluginDir: string, manifest: PluginManifest): { gitHooks: PluginGitHook[]; errors: string[] } {
  const gitHooks: PluginGitHook[] = [];
  const errors: string[] = [];
  for (const [event, leaf] of Object.entries(manifest.gitHooks)) {
    if (!leaf) continue;
    let content: Buffer;
    let argv: string[] | undefined;
    let srcRel: string | undefined;
    if (leaf.kind === "script") {
      const file = path.join(pluginDir, leaf.path);
      let st: fs.Stats;
      try { st = fs.lstatSync(file); } catch { errors.push(`gitHooks.${event}: leaf '${leaf.path}' not found in the payload`); continue; }
      if (st.isSymbolicLink() || !st.isFile()) { errors.push(`gitHooks.${event}: leaf '${leaf.path}' must be a regular file (symlink/special not allowed)`); continue; }
      content = fs.readFileSync(file);
      // spec 265 (H3) — a ${tool:...} reference is allowed ONLY in an argv leaf (no safe whole-token
      // substitution in a free-form script). Fail closed if a script leaf contains one.
      if (containsToolPlaceholder(content.toString("utf8"))) { errors.push(`gitHooks.${event}: leaf '${leaf.path}' contains \${tool:...}; a tool reference is only allowed in an argv leaf`); continue; }
      srcRel = leaf.path;
    } else {
      // spec 265 task 10c — resolve any ${tool:<name>} to a PLUGIN-SCOPED launcher invocation. Workspace- and
      // host-independent: the launcher path is repo-root-RELATIVE (git runs hooks with cwd=repo root → clone-safe),
      // and the valid tool set is the plugin's DECLARED tools (manifest.tools keys). Fail closed on a bad reference.
      const resolved = resolveToolPlaceholders(leaf.argv, { pluginName: manifest.name, provisionedTools: new Set(Object.keys(manifest.tools)), launcherPath: LAUNCHER_REL });
      if ("error" in resolved) { errors.push(`gitHooks.${event}: ${resolved.error}`); continue; }
      content = Buffer.from(argvWrapperScript(resolved.argv), "utf8");
      argv = resolved.argv;
    }
    gitHooks.push({ event, content, contentHash: crypto.createHash("sha256").update(content).digest("hex"), ...(argv ? { argv } : {}), ...(srcRel ? { srcRel } : {}) });
  }
  return { gitHooks, errors };
}

const MAX_SKILLS = 64; // resource cap (untrusted plugin)

/** Discover + validate the plugin's neutral `skills/` payload: each immediate subdir with a SKILL.md is one
 *  skill; its dir name must equal the SKILL.md frontmatter `name`. Absent skills/ → no skills (not an error).
 *  Fail-closed against untrusted payloads: `skills/` and every entry must be REAL files/dirs (no symlink
 *  escaping the plugin boundary), and the immediate fanout is capped before any per-entry work. */
function discoverSkills(pluginDir: string): { skills: PluginSkill[]; errors: string[] } {
  const root = path.join(pluginDir, SKILLS_DIR);

  // `skills/` must be a real directory — a symlink/special would let readdir enumerate OUTSIDE the plugin.
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { skills: [], errors: [] };
    return { skills: [], errors: [`${SKILLS_DIR}: ${(e as NodeJS.ErrnoException).code ?? "read error"}`] };
  }
  if (!rootStat.isDirectory()) return { skills: [], errors: [`${SKILLS_DIR}: must be a real directory (symlink/special not allowed)`] };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return { skills: [], errors: [`${SKILLS_DIR}: ${(e as NodeJS.ErrnoException).code ?? "read error"}`] };
  }

  // cap ALL immediate entries (dirs, symlinks AND regular files) — a hostile repo could flood skills/ with
  // thousands of any kind to force load-time work. Fail closed before filtering/iterating.
  if (entries.length > MAX_SKILLS) return { skills: [], errors: [`${SKILLS_DIR}: too many entries (max ${MAX_SKILLS})`] };
  const candidates = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const skills: PluginSkill[] = [];
  for (const d of candidates) {
    const dirName = d.name;
    if (d.isSymbolicLink()) return { skills: [], errors: [`${SKILLS_DIR}/${dirName}: symlinks are not allowed`] };
    const skillMd = path.join(root, dirName, SKILL_FILE);
    let mdStat: fs.Stats;
    try {
      mdStat = fs.lstatSync(skillMd);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // a subdir without a SKILL.md is not a skill
      return { skills: [], errors: [`${SKILLS_DIR}/${dirName}/${SKILL_FILE}: ${(e as NodeJS.ErrnoException).code ?? "read error"}`] };
    }
    if (!mdStat.isFile()) return { skills: [], errors: [`${SKILLS_DIR}/${dirName}/${SKILL_FILE}: must be a regular file (symlink/special not allowed)`] };
    const skillRead = readFile(skillMd);
    if (skillRead.error) return { skills: [], errors: [`${SKILLS_DIR}/${dirName}/${SKILL_FILE}: ${skillRead.error}`] };
    if (skillRead.missing) continue; // raced away between lstat and read
    const parsed = parseSkillFrontmatter(skillRead.text as string);
    if (!parsed.frontmatter) return { skills: [], errors: parsed.errors.map((e) => `${SKILLS_DIR}/${dirName}/${SKILL_FILE}: ${e}`) };
    if (parsed.frontmatter.name !== dirName) {
      return { skills: [], errors: [`${SKILLS_DIR}/${dirName}: SKILL.md name '${parsed.frontmatter.name}' must equal its directory name '${dirName}'`] };
    }
    skills.push({ name: dirName, description: parsed.frontmatter.description, dirRel: path.posix.join(SKILLS_DIR, dirName) });
  }
  return { skills, errors: [] };
}

/** Discover + validate the plugin's neutral `mcp.json` payload (at the plugin root). Absent → no MCP (not an
 *  error). Fail-closed against untrusted payloads: `mcp.json` must be a REAL regular file (a symlink/special
 *  could point outside the plugin boundary), then parsed by the pure `loadMcpPayload`. */
function discoverMcp(pluginDir: string): { servers: McpServer[]; errors: string[] } {
  const file = path.join(pluginDir, MCP_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], errors: [] };
    return { servers: [], errors: [`${MCP_FILE}: ${(e as NodeJS.ErrnoException).code ?? "read error"}`] };
  }
  if (!stat.isFile()) return { servers: [], errors: [`${MCP_FILE}: must be a regular file (symlink/special not allowed)`] };
  const read = readFile(file);
  if (read.error) return { servers: [], errors: [`${MCP_FILE}: ${read.error}`] };
  if (read.missing) return { servers: [], errors: [] }; // raced away between lstat and read
  const parsed = loadMcpPayload(read.text as string);
  if (!parsed.payload) return { servers: [], errors: parsed.errors };
  return { servers: parsed.payload.servers, errors: [] };
}

/** A planned skill materialization: one plugin skill → one runtime's skills destination. */
export interface SkillTarget {
  runtime: Runtime;
  /** the skill name (= its dir name = its frontmatter name). */
  skill: string;
  /** posix, workspace-relative SOURCE in the committed payload (e.g. `.tachyon/plugins/<plugin>/skills/<skill>`). */
  srcRel: string;
  /** posix, workspace-relative DESTINATION in the runtime's skills dir (e.g. `.claude/skills/<skill>`). */
  destRel: string;
}

/** Whether a runtime has a skills loader Tachyon can materialize into. */
export function runtimeSupportsSkills(runtime: Runtime): boolean {
  return ADAPTERS[runtime].skillsRel !== null;
}

/**
 * Plan the skill materializations: each plugin skill × each PRESENT runtime that supports skills. A runtime
 * absent from the workspace OR with no skills loader is skipped. PURE — no I/O and no collision check yet
 * (Step 3 reads the filesystem to detect a destination collision and apply the human's Keep/Replace choice).
 */
export function planSkillTargets(plugin: LoadedPlugin, present: ReadonlySet<Runtime>): SkillTarget[] {
  const targets: SkillTarget[] = [];
  for (const rt of SUPPORTED_RUNTIMES) {
    if (!plugin.manifest.runtimes.includes(rt) || !present.has(rt)) continue;
    const skillsRel = ADAPTERS[rt].skillsRel;
    if (!skillsRel) continue; // runtime has no skills loader → skip
    for (const skill of plugin.skills) {
      targets.push({
        runtime: rt,
        skill: skill.name,
        srcRel: path.posix.join(PAYLOAD_ROOT, plugin.manifest.name, skill.dirRel),
        destRel: path.posix.join(skillsRel, skill.name),
      });
    }
  }
  return targets;
}

/** A planned MCP materialization: one plugin server → one runtime's MCP config file. */
export interface McpTarget {
  runtime: Runtime;
  /** the neutral server (Step 3's writer renders it per-runtime via the adapter renderers). */
  server: McpServer;
  /** the server name — the lockfile `ref` + the `mcpServers.<ref>` / `[mcp_servers.<ref>]` key for removal. */
  ref: string;
  /** posix, workspace-relative MCP config file the server is merged into (e.g. `.mcp.json`). */
  destRel: string;
}

/** Whether a runtime has an MCP loader Tachyon can materialize into. */
export function runtimeSupportsMcp(runtime: Runtime): boolean {
  return ADAPTERS[runtime].mcpRel !== null;
}

/**
 * Plan the MCP materializations: each plugin server × each PRESENT runtime that supports MCP. A runtime absent
 * from the workspace OR with no MCP loader is skipped (declare-and-skip). PURE — no I/O and no collision check
 * yet (Step 4 reads the config to detect a server-name collision and apply the human's Keep/Replace choice).
 */
export function planMcpTargets(plugin: LoadedPlugin, present: ReadonlySet<Runtime>): McpTarget[] {
  const targets: McpTarget[] = [];
  for (const rt of SUPPORTED_RUNTIMES) {
    if (!plugin.manifest.runtimes.includes(rt) || !present.has(rt)) continue;
    const mcpRel = ADAPTERS[rt].mcpRel;
    if (!mcpRel) continue; // runtime has no MCP loader → skip
    for (const server of plugin.mcp) {
      targets.push({ runtime: rt, server, ref: server.name, destRel: mcpRel });
    }
  }
  return targets;
}

// MCP config FORMAT CODEC (read/render/merge/remove/compare + MCP_SERVER_NAME) lives in `mcpConfig.ts`,
// imported above. The engine keeps the MCP *planning* (planMcpTargets/runtimeSupportsMcp) + the lockfile-target
// *validators* (validMcpDest/validMcpRemoval) below, since those need the adapter registry / trust model.

/** A skill-dir target's twin for MCP: a planned server materialization + whether it collides with a server the
 *  user already configured (needs an explicit Keep/Replace at apply). */
export interface McpPlanItem {
  runtime: Runtime;
  server: McpServer;
  ref: string;
  destRel: string;
  /** the CURRENT on-disk entry under this server name (undefined = absent). Bound into the fingerprint so a
   *  same-name server appearing/changing since consent invalidates it; also the content-ownership proof. */
  current: unknown;
  /** true ⇒ a server named `ref` exists at destRel that this plugin did NOT write (its current entry ≠ our
   *  recorded removal) → needs an explicit Keep/Replace. A prior install of THIS plugin (content matches) is ours. */
  collision: boolean;
}

/** A snapshot of an MCP config file at preview time — the lost-update basis (mirrors a hook step's `before`). */
interface McpConfigSnapshot {
  runtime: Runtime;
  destRel: string;
  /** the file's text at preview (null = absent), fail-closed read. */
  text: string | null;
}

/** A mcp-server target is only legitimate if its file is EXACTLY the runtime's MCP config path — so a
 *  corrupted lockfile can't make remove touch an arbitrary file. */
function validMcpDest(runtime: Runtime, file: string): boolean {
  return ADAPTERS[runtime].mcpRel !== null && file === ADAPTERS[runtime].mcpRel;
}

/** A recorded `removal` is shape-valid for `runtime` only if it looks like something Tachyon actually rendered
 *  for server `ref` (claude: a plain object; codex: a string headed by `[mcp_servers.<ref>]`). This rejects a
 *  corrupted/garbage removal before it is trusted for content-ownership or un-merge. NOTE: it cannot detect a
 *  removal forged to equal a user's CURRENT entry — that is the lockfile trust boundary (see notes § Step 4),
 *  the same boundary skills/hooks rely on; tampering the lockfile needs the same access as editing the config. */
function validMcpRemoval(runtime: Runtime, ref: string, removal: unknown): boolean {
  if (runtime === "claude") return typeof removal === "object" && removal !== null && !Array.isArray(removal);
  if (runtime === "codex") return typeof removal === "string" && removal.startsWith(`[mcp_servers.${ref}]`);
  // grok: no project MCP install path yet (ADAPTERS.grok.mcpRel is null).
  return false;
}

// ── lockfile prior-state reconstruction (runtime-keyed) ─────────────────────

interface PriorOwned {
  owned: OwnedHooks;
  errors: string[];
}

/** Reconstruct the OwnedHooks a prior install recorded FOR ONE RUNTIME, re-validating the opaque `removal`
 *  and rejecting duplicate refs. Keyed by {runtime, kind, file, ref}. */
function priorOwned(lock: PluginLock | undefined, runtime: Runtime, settingsRel: string): PriorOwned {
  const owned: OwnedHooks = {};
  const errors: string[] = [];
  const seenRef = new Set<string>();
  if (!lock) return { owned, errors };
  for (const t of lock.targets) {
    if (t.runtime !== runtime || t.kind !== "settings-hook" || t.file !== settingsRel || !t.ref) continue;
    if (seenRef.has(t.ref)) {
      errors.push(`lockfile: duplicate ${runtime} target ref '${t.ref}'`);
      continue;
    }
    seenRef.add(t.ref);
    const parsed = parseOwnedHooks({ [t.ref]: t.removal });
    if (!parsed.owned) {
      errors.push(`lockfile: malformed removal for ${runtime} '${t.ref}': ${parsed.errors.join("; ")}`);
      continue;
    }
    if (parsed.owned[t.ref]) owned[t.ref] = parsed.owned[t.ref];
  }
  return { owned, errors };
}

function collectCommands(owned: OwnedHooks): string[] {
  const cmds: string[] = [];
  for (const groups of Object.values(owned)) for (const g of groups) for (const h of g.hooks) cmds.push(h.command);
  return cmds;
}

// ── install (preview → apply) ───────────────────────────────────────────────

export interface InstallStep {
  runtime: Runtime;
  settingsRel: string;
  before: HookSettings;
  after: HookSettings;
  owned: OwnedHooks;
  /** SECURITY surface: the shell commands that will run on hook events once installed. */
  wiredCommands: string[];
}

/** A planned skill materialization (spec 251 Step 3): a plugin skill → one runtime's skills dir, plus whether
 *  it collides with a user's existing skill (needs an explicit Keep/Replace decision at apply time). */
export interface SkillPlanItem {
  runtime: Runtime;
  skill: string;
  srcRel: string;
  destRel: string;
  /** true ⇒ a dir already exists at destRel that Tachyon did NOT put there. A prior install of THIS plugin is
   *  ours (not a collision). A real collision is fail-closed at apply: it requires an explicit replace decision. */
  collision: boolean;
}

/** spec 264 — a planned git-hook materialization: one declared leaf → one event, plus the prior hook it will
 *  chain to (from the injected git state) and a consent-display string. */
export interface GitHookPlanItem {
  event: string;
  contentHash: string;
  argv?: string[];
  /** what the consent drawer shows runs on every commit (the argv, or "<script> (payload script)"). */
  display: string;
  /** the prior user hook this install will chain FIRST (from the git state), or null. */
  priorHook: PriorHookIdentity | null;
}

/** spec 285 — one external system tool's status at install preview: detected present/missing + the host-PM
 *  assisted-install argv (when one is offerable) + the manual fallback guidance. */
export interface ExternalToolStatus {
  name: string;
  present: boolean;
  reason?: string;
  /** spec 289 — the candidate binary names when more than one is accepted (audit disclosure); absent for single-name. */
  names?: string[];
  /** spec 289 — the winning trusted path when present (which candidate resolved). */
  resolvedPath?: string;
  /** the validated assisted-install argv for the detected host PM (absent → only manual guidance applies). */
  install?: string[];
  manual: string;
}

/** spec 349 — a planned view registration identity. No host/projection/broker wiring happens in Phase 1. */
export interface ViewTarget {
  id: string;
  title: string;
  surface: ViewDecl["surface"];
  entry: string;
  fileRel: string;
  fleet: ViewDecl["fleet"];
  actions: string[];
}

export interface InstallPreview {
  manifest: PluginManifest;
  steps: InstallStep[];
  /** the skill materializations this install would perform (across present, skills-capable runtimes). */
  skillTargets: SkillPlanItem[];
  /** the MCP-server materializations this install would perform (across present, MCP-capable runtimes). */
  mcpTargets: McpPlanItem[];
  /** per-MCP-config-file snapshot at preview (the lost-update basis re-verified before the step-6 write). */
  mcpConfigBefore: McpConfigSnapshot[];
  /** spec 264 — the git-hook materializations this install would perform (runtime-agnostic). */
  gitHookTargets: GitHookPlanItem[];
  /** spec 265 — the tools this install would provision for the running host (resolved platform + final URL +
   *  checksums). Empty when the plugin declares no tools or no tool plan was injected. */
  toolTargets: ToolPlanItem[];
  /** spec 284 — the DATA artifacts this install would provision (non-executable; resolved platform + final URL +
   *  checksum). Empty when the plugin declares no data or no data plan was injected. */
  dataTargets: DataPlanItem[];
  /** spec 285 — the EXTERNAL system tools this plugin needs, with their detected present/missing status + the
   *  host-PM assisted-install argv (if offerable) + manual guidance. Empty when none declared. Informational at
   *  install (the plugin installs regardless; the skill fail-closes at runtime if a tool is missing). */
  externalTargets: ExternalToolStatus[];
  /** spec 349 — runtime-agnostic UI surfaces this install would register once the host layer exists. */
  viewTargets: ViewTarget[];
  /** spec 263 — the declared runtimes this install will MATERIALIZE (the consented target set), normalized
   *  + sorted. Bound into the fingerprint so selecting vs DEselecting a runtime that produces NO per-runtime
   *  artifact (no hooks/skills/MCP) still changes consent. */
  targetRuntimes: Runtime[];
  /** declared runtimes NOT materialized here: DEselected from the target set (spec 263; pre-263 this meant
   *  "absent from the workspace" — install no longer gates on a runtime's config dir pre-existing). */
  skipped: Runtime[];
  warnings: string[];
  errors: string[];
  fingerprint: string;
  payloadHash: string;
  /** spec 276 — the DIRECT declared dependencies' install-time states (satisfied/out-of-range/missing); the
   *  consent drawer surfaces these. Advisory: a missing/out-of-range dep never blocks install. */
  requires: DependencyState[];
}

/** Absolute materialized payload root for a plugin (where `${PLUGIN_ROOT}` resolves for MCP render). */
function pluginPayloadAbs(workspaceRoot: string, pluginName: string): string {
  return path.join(workspaceRoot, PAYLOAD_ROOT, pluginName);
}

function fingerprintOf(plugin: LoadedPlugin, workspaceRoot: string, targetRuntimes: Runtime[], steps: InstallStep[], skillTargets: SkillPlanItem[], mcpTargets: McpPlanItem[], mcpConfigBefore: McpConfigSnapshot[], gitHookTargets: GitHookPlanItem[], gitState: GitHookState | undefined, toolTargets: ToolPlanItem[], dataTargets: DataPlanItem[], viewTargets: ViewTarget[], payloadHash: string): string {
  const pluginRoot = pluginPayloadAbs(workspaceRoot, plugin.manifest.name);
  const basis = {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    payload: payloadHash,
    // spec 264 — bind the git-hook plan + the live git state it depends on: the leaf set, the current
    // core.hooksPath (raw+resolved), the chained prior-hook identity per event, the ownership generation, and
    // worktree-config — so ANY of these drifting since consent invalidates the fingerprint.
    gitHooks: {
      targets: gitHookTargets.map((g) => ({ event: g.event, hash: g.contentHash })),
      hooksPath: gitState?.hooksPath ? { raw: gitState.hooksPath.raw, resolved: gitState.hooksPath.resolved } : null,
      prior: gitHookTargets.map((g) => ({ event: g.event, prior: g.priorHook })),
      generation: gitState?.ownership?.generation ?? null,
      worktreeConfig: gitState?.worktreeConfig ?? false,
    },
    // spec 263 — the consented runtime selection, bound EXPLICITLY (not "for free"): a declared runtime with no
    // per-runtime artifact contributes nothing to steps/skills/mcp, so select-vs-deselect would otherwise hash
    // identically. Normalized + sorted upstream for stability.
    targetRuntimes,
    steps: steps.map((s) => ({ rt: s.runtime, before: s.before, after: s.after })),
    // bind the skill plan + which dests collide (a changed collision set must invalidate consent).
    skills: skillTargets.map((s) => ({ rt: s.runtime, dest: s.destRel, collision: s.collision })),
    // bind the MCP plan: rendered entry (a payload edit changes it; ${PLUGIN_ROOT} is bound via absolute root) +
    // the CURRENT on-disk entry + collision — so a same-name server appearing/changing since consent invalidates the fingerprint.
    mcp: mcpTargets.map((m) => ({ rt: m.runtime, ref: m.ref, entry: renderMcp(m.runtime, m.server, pluginRoot), current: m.current, collision: m.collision })),
    // bind each MCP config file snapshot (the lost-update basis): ANY change to the file invalidates consent.
    mcpConfig: mcpConfigBefore.map((c) => ({ rt: c.runtime, dest: c.destRel, text: c.text })),
    // spec 349 — bind UI surface identity + scopes/actions so any surface change requires fresh consent.
    views: viewTargets.map((v) => ({ id: v.id, title: v.title, surface: v.surface, entry: v.entry, fleet: v.fleet, actions: v.actions })),
    // spec 265 — bind the tool plan to the HARD integrity facts: resolved platform + declared URL + both
    // checksums. finalUrl is recorded provenance, NOT bound (codex task-10 review D): a benign signed/redirected
    // URL change must not re-prompt consent — the pinned sha256 is the real integrity gate, re-verified at fetch.
    // spec 269 — bind the launch policy too: the forced env/args/denyArgs are part of what the user consents the
    // tool to ALWAYS run with, so any change must re-prompt (the launcher enforces exactly the consented policy).
    tools: toolTargets.map((t) => ({ name: t.name, platform: t.resolvedPlatform, declaredUrl: t.declaredUrl, sha256: t.sha256, binSha256: t.binSha256, launchPolicy: t.launchPolicy ?? null })),
    // spec 284 — bind the DATA plan to its integrity facts (platform + declared URL + content sha + leaf). Added
    // ONLY when there's data, so a plugin with no data hashes BYTE-IDENTICALLY to before this feature (codex C3).
    ...(dataTargets.length > 0 ? { data: dataTargets.map((d) => ({ name: d.name, platform: d.resolvedPlatform, declaredUrl: d.declaredUrl, sha256: d.sha256, fileName: d.fileName })) } : {}),
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

/** Catch the common placeholder typo (spec 268 follow-up): a hook / git-hook command that references a
 *  `${…PLUGIN…ROOT…}` token which is NOT the substituted `${TACHYON_PLUGIN_ROOT}`. Such a token is never
 *  replaced and the shell expands it to EMPTY at runtime (e.g. `${PLUGIN_ROOT}` → runs `/guard.sh` → "not
 *  found"), silently breaking the hook. Surfaced as a non-blocking install warning so it's caught at consent. */
function placeholderTypoWarnings(plugin: LoadedPlugin): string[] {
  const TOKEN = /\$\{[^}]*PLUGIN[^}]*ROOT[^}]*\}/gi;
  const bad = new Set<string>();
  const scan = (s: string) => { for (const m of s.matchAll(TOKEN)) if (m[0] !== PLUGIN_ROOT_PLACEHOLDER) bad.add(m[0]); };
  for (const rt of Object.keys(plugin.blocks) as Runtime[]) scan(JSON.stringify(plugin.blocks[rt]));
  for (const g of plugin.gitHooks) { if (g.argv) scan(g.argv.join(" ")); scan(g.content.toString("utf8")); }
  return [...bad].map((t) => `hook references ${t}, which Tachyon does not substitute — did you mean ${PLUGIN_ROOT_PLACEHOLDER}? it expands to empty at runtime and breaks the hook`);
}

/** spec 272 — a `${tool:<name>}` token in a SKILL payload file. Unlike a git-hook argv leaf (where it resolves to
 *  a launcher invocation), a skill payload is materialized VERBATIM, so the token reaches the agent's script
 *  literally and the tool is never resolved — a silent runtime break. Surfaced as a non-blocking install warning
 *  (NOT a hard reject: a SKILL.md may legitimately *document* the token, and no substitution is attempted so there
 *  is no security boundary). The supported contract is to invoke the provisioned tool through the launcher
 *  (`.tachyon/bin/_tachyon-tool <plugin> <tool>`). Bounded by the same payload caps preflight already enforced. */
function skillToolPlaceholderWarnings(plugin: LoadedPlugin): string[] {
  const TOKEN = /\$\{tool:[^}]*\}/;
  const hits = new Set<string>();
  const walk = (d: string, depth: number): void => {
    if (depth > MAX_PAYLOAD_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.isFile()) {
        let text: string;
        try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
        if (TOKEN.test(text)) hits.add(path.posix.relative(plugin.dir, p));
      }
    }
  };
  for (const skill of plugin.skills) walk(path.join(plugin.dir, skill.dirRel), 0);
  return [...hits].map((rel) => `skill payload '${rel}' contains a \${tool:…} token, which Tachyon does not substitute in skill payloads — invoke the provisioned tool through the launcher instead (.tachyon/bin/_tachyon-tool <plugin> <tool>)`);
}

/** Plan an install WITHOUT writing: preflight payload, read each runtime's config + the lockfile fail-closed,
 *  compute the merges, return the diff + wired commands + a consent fingerprint. */
export function previewInstall(plugin: LoadedPlugin, workspaceRoot: string, target: ReadonlySet<Runtime>, gitState?: GitHookState, toolPlan?: ToolPlan, dataPlan?: DataPlan): InstallPreview {
  const { manifest } = plugin;
  const empty = (errors: string[]): InstallPreview => ({ manifest, steps: [], skillTargets: [], mcpTargets: [], mcpConfigBefore: [], gitHookTargets: [], toolTargets: [], dataTargets: [], externalTargets: [], viewTargets: [], targetRuntimes: [], skipped: [], warnings: [], errors, fingerprint: "", payloadHash: "", requires: [] });

  const payload = preflightPayload(plugin.dir);
  if (payload.errors.length > 0) return empty(payload.errors);

  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return empty(lockRead.errors);
  const lock = lockRead.lockfile.plugins[manifest.name];

  // spec 263 — `target` is the runtimes to MATERIALIZE (the installer's selection; default = all declared),
  // NOT "runtimes whose config dir already exists". resolveCompat(declared ∩ target) → `installable` is the
  // materialize set; `missingFromWorkspace` is now "declared but DEselected" (the install creates whatever
  // structure a selected runtime needs; it never gates on a pre-existing `.claude/`/`.codex/`).
  const compat = resolveCompat(manifest, target);
  const targetRuntimes = [...compat.installable].sort();
  const steps: InstallStep[] = [];
  const skipped: Runtime[] = [...compat.missingFromWorkspace];
  const warnings: string[] = [];
  const errors: string[] = [];
  // declared runtimes with NO hooks block — they may still contribute a skill/MCP (a skills-only plugin like
  // skills-only plugins). We defer the "nothing to wire" warning until after skill+MCP planning, then emit it only for runtimes
  // that materialize NOTHING — otherwise the message wrongly fires on every skills-only / MCP-only plugin.
  const noHookRuntimes = new Set<Runtime>();

  for (const rt of compat.installable) {
    const spec = ADAPTERS[rt];
    const block = plugin.blocks[rt];
    const rootRel = plugin.rootRel[rt];
    if (!block || !rootRel) {
      noHookRuntimes.add(rt);
      continue;
    }
    const prior = priorOwned(lock, rt, spec.settingsRel);
    if (prior.errors.length > 0) return empty(prior.errors);
    const read = readSettings(path.join(workspaceRoot, spec.settingsRel));
    if (!read.settings) {
      errors.push(...read.errors);
      continue;
    }
    // spec 321 — hook commands bake the ABSOLUTE plugin root (cwd-independent; see adapters/hooks.ts).
    const merge = mergeHooks(read.settings, block, path.join(workspaceRoot, rootRel), prior.owned);
    if (!merge.settings || !merge.owned) {
      errors.push(...merge.errors.map((e) => `${rt}: ${e}`));
      continue;
    }
    steps.push({
      runtime: rt,
      settingsRel: spec.settingsRel,
      before: read.settings,
      after: merge.settings,
      owned: merge.owned,
      wiredCommands: collectCommands(merge.owned),
    });
  }

  // spec 251 Step 3 — plan skill materializations + detect collisions. A dest already present that is NOT one
  // of THIS plugin's prior skill-dirs (from the lockfile) is a USER collision → needs an explicit Keep/Replace.
  const priorSkillDests = new Set((lock?.targets ?? []).filter((t) => t.kind === "skill-dir").map((t) => t.file));
  const skillTargets: SkillPlanItem[] = planSkillTargets(plugin, target).map((t) => ({
    ...t,
    collision: !priorSkillDests.has(t.destRel) && fs.existsSync(path.join(workspaceRoot, t.destRel)),
  }));

  // spec 254 Step 4 — plan MCP materializations + detect collisions. Ownership is proven by CONTENT, not a
  // lockfile claim: a server is "ours" (not a collision) only if a prior mcp-server target records it AND the
  // current on-disk entry equals that target's recorded `removal`. A present same-name server we don't own is a
  // USER collision → Keep/Replace. Prior targets are validated fail-closed; configs read fail-closed.
  const mcpPlan = planMcpTargets(plugin, target);
  const priorMcpTargets = (lock?.targets ?? []).filter((t): t is MaterializedTarget & { runtime: Runtime; ref: string } => t.kind === "mcp-server" && !!t.runtime && typeof t.ref === "string");
  for (const t of priorMcpTargets) {
    if (!validMcpDest(t.runtime, t.file) || typeof t.ref !== "string" || !MCP_SERVER_NAME.test(t.ref) || !validMcpRemoval(t.runtime, t.ref, t.removal)) {
      return empty([`lockfile: mcp-server target '${t.file}' (${t.runtime}) is not a valid MCP config target — fix the lockfile`]);
    }
  }
  const priorOwnedMcp = new Map<string, unknown>();
  for (const t of priorMcpTargets) priorOwnedMcp.set(`${t.runtime} ${t.file} ${t.ref}`, t.removal);

  const mcpConfig = new Map<string, string | undefined>(); // destRel -> current text (one fail-closed read per file)
  const mcpConfigBefore: McpConfigSnapshot[] = [];
  const seenDest = new Set<string>();
  for (const t of mcpPlan) {
    if (seenDest.has(t.destRel)) continue;
    seenDest.add(t.destRel);
    const rd = readMcpConfig(workspaceRoot, t.runtime, t.destRel);
    if (rd.error) { errors.push(rd.error); continue; }
    mcpConfig.set(t.destRel, rd.text);
    mcpConfigBefore.push({ runtime: t.runtime, destRel: t.destRel, text: rd.text ?? null });
  }
  const mcpTargets: McpPlanItem[] = mcpPlan.map((t) => {
    const current = currentMcp(t.runtime, mcpConfig.get(t.destRel), t.ref);
    const ownedRemoval = priorOwnedMcp.get(`${t.runtime} ${t.destRel} ${t.ref}`);
    const ours = ownedRemoval !== undefined && current !== undefined && mcpRepEquals(current, ownedRemoval);
    return { ...t, current, collision: current !== undefined && !ours };
  });

  // a declared runtime with no hooks block still contributes if it receives a skill or an MCP server; only warn
  // when the runtime materializes NOTHING for this plugin (a genuinely pointless declaration). Fixes the false
  // "nothing to wire" alert on skills-only / MCP-only plugins.
  for (const rt of noHookRuntimes) {
    if (!skillTargets.some((t) => t.runtime === rt) && !mcpTargets.some((t) => t.runtime === rt)) {
      warnings.push(`${rt}: plugin declares ${rt} but materializes nothing for it (no hooks, skills, or MCP)`);
    }
  }

  // spec 264 — plan git-hook materializations from the injected git state (runtime-agnostic).
  const gitHookTargets = planGitHooks(plugin, gitState, errors);

  // spec 265 — the injected tool plan (resolved off the running host). Tools that can't be provisioned for this
  // host surface as warnings; a git-hook leaf referencing a missing tool fails closed at materialization (task 10).
  const toolTargets = toolPlan?.items ?? [];
  for (const u of toolPlan?.unsupported ?? []) warnings.push(`tool '${u.name}': ${u.reason} — not provisioned on this host`);
  // spec 284 — the DATA artifacts to provision (non-executable); unsupported per-platform pins surface as warnings.
  const dataTargets = dataPlan?.items ?? [];
  for (const u of dataPlan?.unsupported ?? []) warnings.push(`data '${u.name}': ${u.reason} — not provisioned on this host`);
  // spec 285 — detect each declared external system tool (present/missing) + resolve its host-PM assisted-install
  // argv. Informational: the plugin installs regardless; a missing tool surfaces a warning, the skill fail-closes.
  const externalTargets: ExternalToolStatus[] = Object.entries(manifest.externalTools).map(([name, d]) => {
    const det = detectExternalTool(name, d);
    const ai = det.present ? null : buildAssistedInstall(d.install);
    if (!det.present) warnings.push(`external tool '${name}' is not installed — ${ai && ai.ok ? "an assisted install is available" : d.manual}`);
    return {
      name, present: det.present,
      ...(det.present ? { resolvedPath: det.path } : { reason: det.reason }),
      ...(d.names && d.names.length > 1 ? { names: d.names } : {}), // spec 289 — disclose the candidate set (>1)
      ...(ai && ai.ok ? { install: ai.argv } : {}),
      manual: d.manual,
    };
  });

  // catch a mistyped plugin-root placeholder (e.g. ${PLUGIN_ROOT} instead of ${TACHYON_PLUGIN_ROOT}) before it
  // ships — it would expand to empty at runtime and silently break the hook.
  for (const w of placeholderTypoWarnings(plugin)) warnings.push(w);
  for (const w of skillToolPlaceholderWarnings(plugin)) warnings.push(w);

  const viewTargets = planViewTargets(plugin, errors);

  const fingerprint = errors.length > 0 ? "" : fingerprintOf(plugin, workspaceRoot, targetRuntimes, steps, skillTargets, mcpTargets, mcpConfigBefore, gitHookTargets, gitState, toolTargets, dataTargets, viewTargets, payload.hash);
  const requires = dependencyStates(manifest.dependencies, lockRead.lockfile); // spec 276 — direct deps vs lockfile
  return { manifest, steps, skillTargets, mcpTargets, mcpConfigBefore, gitHookTargets, toolTargets, dataTargets, externalTargets, viewTargets, targetRuntimes, skipped, warnings, errors, fingerprint, payloadHash: payload.hash, requires };
}

function planViewTargets(plugin: LoadedPlugin, errors: string[]): ViewTarget[] {
  const targets: ViewTarget[] = [];
  for (const v of plugin.views ?? []) {
    const entryAbs = path.join(plugin.dir, v.entry);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(entryAbs);
    } catch {
      errors.push(`views.${v.id}.entry: '${v.entry}' not found in the payload`);
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      errors.push(`views.${v.id}.entry: '${v.entry}' must be a regular file (symlink/special not allowed)`);
      continue;
    }
    const html = fs.readFileSync(entryAbs, "utf8");
    const htmlValidation = validateEntryHtml(html);
    if (!htmlValidation.ok) {
      errors.push(`views.${v.id}.entry: ${htmlValidation.reason}`);
      continue;
    }
    targets.push({ id: v.id, title: v.title, surface: v.surface, entry: v.entry, fileRel: path.posix.join(PAYLOAD_ROOT, plugin.manifest.name, v.entry), fleet: v.fleet, actions: v.actions });
  }
  return targets;
}

/** Plan the git-hook materializations from the injected git state. Errors (not a repo / worktree-config) are
 *  pushed; an empty plan when the plugin declares no git-hooks. */
function planGitHooks(plugin: LoadedPlugin, gitState: GitHookState | undefined, errors: string[]): GitHookPlanItem[] {
  if (plugin.gitHooks.length === 0) return [];
  if (!gitState || !gitState.isRepo) {
    errors.push("git-hook: not a git repository — a git-hook plugin can only install into a git work tree");
    return [];
  }
  if (gitState.worktreeConfig) {
    errors.push("git-hook: extensions.worktreeConfig is enabled — Tachyon refuses to manage git hooks here (ambiguous scope)");
    return [];
  }
  return plugin.gitHooks.map((g) => ({
    event: g.event,
    contentHash: g.contentHash,
    ...(g.argv ? { argv: g.argv } : {}),
    display: g.argv ? g.argv.join(" ") : `${g.srcRel ?? "leaf"} (payload script)`,
    priorHook: gitState.priorHooks[g.event] ?? null,
  }));
}

export interface InstallResult {
  installed: boolean;
  runtimes: Runtime[];
  errors: string[];
}

/** Apply a previewed install: re-derive + refuse a stale preview (TOCTOU), then write payload → lockfile →
 *  settings, staging + hash-checking the payload copy and lost-update-checking each settings file first. */
interface ApplyOpts {
  provenance?: InstallProvenance;
  skillDecisions?: Record<string, "keep" | "replace">;
  mcpDecisions?: Record<string, "keep" | "replace">;
  mcpConfirmed?: boolean;
  gitHookConfirmed?: boolean;
  toolConfirmed?: boolean;
  launcherBundlePath?: string;
  /** spec 284 — the data acknowledgement + the data-resolver bundle path (the extension supplies the latter). */
  dataConfirmed?: boolean;
  dataResolverBundlePath?: string;
  /** spec 285 — the external-resolver bundle path (the extension supplies it; needed when the plugin declares
   *  external tools so the `_tachyon-external` shim is materialized). */
  externalResolverBundlePath?: string;
  nodePath?: string;
  toolTlsCa?: string | Buffer;
  viewConfirmed?: boolean;
  fleetReadConfirmed?: boolean;
  actionConfirmed?: Record<string, true>;
  /** spec 287 — best-effort download progress (threaded into provisionTools/provisionData). */
  onProgress?: ProvisionProgressFn;
  resolveFinalUrl?: (url: string) => Promise<string>;
  git?: GitRun;
}

/** PHASE 1 — the fail-closed ack/consent gates (beyond the fingerprint TOCTOU). Returns an error string or
 *  undefined. An MCP server / git-hook / tool each requires its dedicated acknowledgement even from a non-UI
 *  caller (stronger than the drawer's disabled button). */
function checkInstallAckGates(fresh: InstallPreview, opts: ApplyOpts): string | undefined {
  if (fresh.steps.length === 0 && fresh.skillTargets.length === 0 && fresh.mcpTargets.length === 0 && fresh.gitHookTargets.length === 0 && fresh.viewTargets.length === 0) {
    return "nothing to install: no hooks, skills, MCP servers, git-hooks, or views for this plugin";
  }
  if (fresh.viewTargets.length > 0 && opts.viewConfirmed !== true) {
    return "views draw UI in the editor — re-open the consent drawer and confirm the view acknowledgement before installing";
  }
  if (fresh.viewTargets.some((v) => v.fleet === "summary") && opts.fleetReadConfirmed !== true) {
    return "views read a curated fleet summary — re-open the consent drawer and confirm the fleet-read acknowledgement before installing";
  }
  for (const v of fresh.viewTargets) {
    for (const action of v.actions) {
      if (opts.actionConfirmed?.[`${v.id}:${action}`] !== true) {
        return `view action '${action}' for '${v.id}' requires a dedicated acknowledgement before installing`;
      }
    }
  }
  if (fresh.mcpTargets.length > 0 && opts.mcpConfirmed !== true) {
    return "MCP servers require the consent drawer's MCP acknowledgement — re-open and confirm before installing";
  }
  if (fresh.gitHookTargets.length > 0 && opts.gitHookConfirmed !== true) {
    return "git-hooks run on every commit — re-open the consent drawer and confirm the git-hook acknowledgement before installing";
  }
  if (fresh.toolTargets.length > 0 && opts.toolConfirmed !== true) {
    return "tools download + execute a binary — re-open the consent drawer and confirm the tool acknowledgement before installing";
  }
  if (fresh.dataTargets.length > 0 && opts.dataConfirmed !== true) {
    return "data artifacts download + store a checksummed file — re-open the consent drawer and confirm the data acknowledgement before installing";
  }
  if (fresh.dataTargets.length > 0 && !opts.dataResolverBundlePath) {
    return "internal: data provisioning requires the data-resolver bundle path (dataResolverBundlePath) — the extension supplies it";
  }
  if (fresh.externalTargets.length > 0 && !opts.externalResolverBundlePath) {
    return "internal: a plugin with external tools requires the external-resolver bundle path (externalResolverBundlePath) — the extension supplies it";
  }
  if (fresh.toolTargets.length > 0 && !opts.launcherBundlePath) {
    return "internal: tool provisioning requires the launcher bundle path (launcherBundlePath) — the extension supplies it";
  }
  return undefined;
}

/** PHASE 2a — validate THIS plugin's prior lockfile targets fail-closed (a corrupted skill-dir/mcp-server target
 *  must not be trusted: it could suppress a real collision or get stale-deleted). Returns an error or undefined. */
function validViewTarget(pluginName: string, t: MaterializedTarget): boolean {
  return t.kind === "view" && t.runtime === undefined && typeof t.ref === "string" && t.ref.length > 0 && t.file.startsWith(`${PAYLOAD_ROOT}/${pluginName}/`);
}

function validatePriorTargets(pluginName: string, priorTargets: MaterializedTarget[]): string | undefined {
  for (const t of priorTargets) {
    if (t.kind === "skill-dir" && (!t.runtime || !validSkillDest(t.runtime, t.file))) {
      return `lockfile: skill-dir target '${t.file}' (${t.runtime}) is not a valid skills path — fix the lockfile before installing`;
    }
    if (t.kind === "mcp-server" && (!t.runtime || !validMcpDest(t.runtime, t.file) || typeof t.ref !== "string" || !MCP_SERVER_NAME.test(t.ref) || !validMcpRemoval(t.runtime, t.ref, t.removal))) {
      return `lockfile: mcp-server target '${t.file}' (${t.runtime}) is not a valid MCP config path — fix the lockfile before installing`;
    }
    if (t.kind === "view" && !validViewTarget(pluginName, t)) {
      return `lockfile: view target '${t.file}' is not a valid view target for '${pluginName}' — fix the lockfile before installing`;
    }
  }
  return undefined;
}

/** PHASE 2b — resolve each colliding skill against its consented Keep/Replace (fail-closed on an undecided
 *  collision; a Kept collision is dropped). Returns the write set or an error. */
function resolveSkillWrites(skillTargets: SkillPlanItem[], decisions: Record<string, "keep" | "replace">): { writes: Array<SkillPlanItem & { replace: boolean }> } | { error: string } {
  const writes: Array<SkillPlanItem & { replace: boolean }> = [];
  for (const st of skillTargets) {
    if (st.collision) {
      const d = decisions[st.destRel];
      if (d === undefined) return { error: `skill '${st.skill}' (${st.runtime}) collides with an existing skill at ${st.destRel} — choose Keep or Replace and re-consent` };
      if (d === "keep") continue;
      writes.push({ ...st, replace: true });
    } else {
      writes.push({ ...st, replace: false });
    }
  }
  return { writes };
}

/** PHASE 2c — resolve each colliding MCP server against its consented Keep/Replace (fail-closed; a Kept
 *  collision is neither merged nor recorded). Returns the write set or an error. */
function resolveMcpWrites(mcpTargets: McpPlanItem[], mcpDecisions: Record<string, "keep" | "replace">): { writes: McpPlanItem[] } | { error: string } {
  const writes: McpPlanItem[] = [];
  for (const mt of mcpTargets) {
    if (mt.collision) {
      const d = mcpDecisions[`${mt.runtime} ${mt.ref}`];
      if (d === undefined) return { error: `MCP server '${mt.ref}' (${mt.runtime}) collides with an existing server in ${mt.destRel} — choose Keep or Replace and re-consent` };
      if (d === "keep") continue;
      writes.push(mt);
    } else {
      writes.push(mt);
    }
  }
  return { writes };
}

/** PHASE 2d — build the materialized-target set (the uninstall manifest) + the runtimes this install touches,
 *  from the resolved hooks/skills/mcp writes.
 *
 *  SDD 486 Phase C: MCP servers are still *recorded* here (so apply/unapply have a removal identity), but
 *  activateInstall does not write them unless AppliedStateStore says that server is applied. Install must
 *  not expand the agent's tool surface. */
function buildInstallTargets(fresh: InstallPreview, skillsToWrite: Array<SkillPlanItem & { replace: boolean }>, mcpToWrite: McpPlanItem[], pluginRoot: string): { runtimes: Runtime[]; targets: MaterializedTarget[] } {
  const runtimes: Runtime[] = [];
  const targets: MaterializedTarget[] = [];
  for (const step of fresh.steps) {
    for (const [event, groups] of Object.entries(step.owned)) {
      targets.push({ runtime: step.runtime, kind: "settings-hook", file: step.settingsRel, ref: event, removal: groups });
    }
    runtimes.push(step.runtime);
  }
  for (const st of skillsToWrite) {
    targets.push({ runtime: st.runtime, kind: "skill-dir", file: st.destRel });
    if (!runtimes.includes(st.runtime)) runtimes.push(st.runtime);
  }
  for (const mt of mcpToWrite) {
    // removal identity is the SUBSTITUTED form written to disk — un-merge content-matches against this.
    targets.push({ runtime: mt.runtime, kind: "mcp-server", file: mt.destRel, ref: mt.ref, removal: renderMcp(mt.runtime, mt.server, pluginRoot) });
    if (!runtimes.includes(mt.runtime)) runtimes.push(mt.runtime);
  }
  for (const vt of fresh.viewTargets) targets.push({ kind: "view", file: vt.fileRel, ref: vt.id });
  return { runtimes, targets };
}

interface ActivateCtx {
  plugin: LoadedPlugin;
  workspaceRoot: string;
  fresh: InstallPreview;
  skillsToWrite: Array<SkillPlanItem & { replace: boolean }>;
  mcpToWrite: McpPlanItem[];
  priorSkillDests: Set<string>;
  priorMcpTargets: MaterializedTarget[];
  priorGitHooks: GitHookLock[];
  gitState: GitHookState | undefined;
  gitGeneration: number;
  git: GitRun;
}

/** PHASE 6 — ACTIVATE (after the lockfile commit): write settings (3) → skills (4) → drop stale skill-dirs (5)
 *  → merge MCP servers (6) → git-hooks LAST (7). Every write is removable (the lockfile already records it), so
 *  a mid-activation failure returns a "partial install … run remove" error string the caller surfaces. */
async function activateInstall(ctx: ActivateCtx): Promise<string | undefined> {
  const { plugin, workspaceRoot, fresh, skillsToWrite, mcpToWrite, priorSkillDests, priorMcpTargets, priorGitHooks, gitState, gitGeneration, git } = ctx;
  const partial = (what: string, e: unknown) => `partial install: payload + lockfile recorded, but ${what} failed (${e instanceof Error ? e.message : String(e)}) — run remove '${plugin.manifest.name}' to clean up, then retry`;

  let appliedRefs: ContributionRef[];
  try {
    appliedRefs = new AppliedStateStore(workspaceRoot).appliedFor(plugin.manifest.name);
  } catch (e) {
    return partial("reading applied-state", e);
  }
  const appliedSkills = new Set(appliedRefs.filter((r) => r.kind === "skill").map((r) => r.name));
  const appliedHooks = new Set(appliedRefs.filter((r) => r.kind === "hook").map((r) => r.name));
  const appliedGitHooks = new Set(appliedRefs.filter((r) => r.kind === "git-hook").map((r) => r.name));

  // 3) Hooks are recorded at install, but only applied events are materialized. Starting from the
  // full preview merge and content-unmerging every disabled event also updates an already-applied
  // hook without ever arming its installed-but-disabled neighbours.
  for (const step of fresh.steps) {
    try {
      let settings = step.after;
      for (const [event, groups] of Object.entries(step.owned)) {
        if (appliedHooks.has(event)) continue;
        const removed = removeHooks(settings, { [event]: groups });
        if (!removed.settings) return partial(`preparing ${step.settingsRel}`, removed.errors.join("; "));
        settings = removed.settings;
      }
      writeSettings(path.join(workspaceRoot, step.settingsRel), settings);
    } catch (e) {
      return partial(`writing ${step.settingsRel}`, e);
    }
  }

  // 4) skills — copy each consented skill from the committed payload. A Replace (or our own prior) dest is wiped
  // first; a CLEAN dest that has APPEARED since preview fails closed (never wipe a new occupant).
  for (const st of skillsToWrite.filter((s) => appliedSkills.has(s.skill))) {
    const destAbs = path.join(workspaceRoot, st.destRel);
    const srcAbs = path.join(workspaceRoot, st.srcRel);
    if (!st.replace && !priorSkillDests.has(st.destRel) && fs.existsSync(destAbs)) {
      return `skill destination ${st.destRel} appeared since preview — re-preview and re-consent`;
    }
    try {
      fs.rmSync(destAbs, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.cpSync(srcAbs, destAbs, { recursive: true, dereference: false });
    } catch (e) {
      return partial(`writing skill '${st.skill}' to ${st.destRel}`, e);
    }
  }

  // 5) update cleanup — delete skill-dirs THIS plugin owned before but the new version no longer ships.
  const newSkillDests = new Set(skillsToWrite.filter((s) => appliedSkills.has(s.skill)).map((s) => s.destRel));
  for (const old of priorSkillDests) {
    if (appliedSkills.has(path.posix.basename(old)) && !newSkillDests.has(old)) fs.rmSync(path.join(workspaceRoot, old), { recursive: true, force: true });
  }

  // 6) MCP servers — SDD 486 Phase C: install records lockfile targets but does NOT write the runtime
  // config unless the contribution is already applied (an update of a live server). First install leaves
  // the agent's tool surface unchanged. Content-aware stale cleanup still drops a previously-applied
  // server the new version no longer ships, and never clobbers a human-edited entry.
  const pluginRoot = pluginPayloadAbs(workspaceRoot, plugin.manifest.name);
  const mcpBefore = new Map(fresh.mcpConfigBefore.map((c) => [c.destRel, c.text]));
  const appliedMcp = new Set(appliedRefs.filter((r) => r.kind === "mcp").map((r) => r.name));
  const priorMcpRuntimes = priorMcpTargets.map((t) => t.runtime).filter((rt): rt is Runtime => rt !== undefined);
  const mcpRuntimes = new Set<Runtime>([...mcpToWrite.map((m) => m.runtime), ...priorMcpRuntimes]);
  for (const rt of mcpRuntimes) {
    const mcpRel = ADAPTERS[rt].mcpRel;
    if (!mcpRel) continue;
    const file = path.join(workspaceRoot, mcpRel);
    const rd = readMcpConfig(workspaceRoot, rt, mcpRel);
    if (rd.error) return `partial install: payload + lockfile recorded, but ${rd.error} — run remove '${plugin.manifest.name}' to clean up, then retry`;
    if (mcpBefore.has(mcpRel) && (rd.text ?? null) !== mcpBefore.get(mcpRel)) {
      return `${mcpRel} changed since preview — re-preview and re-consent before installing`;
    }
    let text = rd.text;
    const writeRefs = new Set(mcpToWrite.filter((m) => m.runtime === rt && appliedMcp.has(m.ref)).map((m) => m.ref));
    try {
      for (const t of priorMcpTargets) {
        if (t.runtime !== rt || !t.ref || writeRefs.has(t.ref)) continue;
        if (!appliedMcp.has(t.ref)) continue; // never applied — nothing on disk that is ours to drop
        if (mcpRepEquals(currentMcp(rt, text, t.ref), t.removal)) text = removeMcpServerText(rt, text, t.ref);
      }
      for (const m of mcpToWrite.filter((x) => x.runtime === rt && appliedMcp.has(x.ref))) text = setMcpServer(rt, text, m.server, pluginRoot);
      if (text !== rd.text) writeMcpConfig(file, text ?? "");
    } catch (e) {
      return partial(`writing ${mcpRel}`, e);
    }
  }
  // a server the new version dropped is no longer applyable — forget it so a later re-add is a fresh apply
  const stillShipped = new Set(mcpToWrite.map((m) => m.ref));
  const store = new AppliedStateStore(workspaceRoot);
  for (const name of appliedMcp) {
    if (!stillShipped.has(name)) store.markUnapplied(plugin.manifest.name, { kind: "mcp", name });
  }
  const shippedSkills = new Set(skillsToWrite.map((s) => s.skill));
  for (const name of appliedSkills) if (!shippedSkills.has(name)) store.markUnapplied(plugin.manifest.name, { kind: "skill", name });
  const shippedHooks = new Set(fresh.steps.flatMap((s) => Object.keys(s.owned)));
  for (const name of appliedHooks) if (!shippedHooks.has(name)) store.markUnapplied(plugin.manifest.name, { kind: "hook", name });
  const shippedGitHooks = new Set(fresh.gitHookTargets.map((g) => g.event));
  const droppedGitHooks = new Set(priorGitHooks.map((g) => g.event).filter((event) => appliedGitHooks.has(event) && !shippedGitHooks.has(event)));
  if (droppedGitHooks.size > 0) {
    try { await removeGitHooks({ name: plugin.manifest.name, version: plugin.manifest.version, runtimes: [], targets: [], gitHooks: priorGitHooks }, workspaceRoot, git, droppedGitHooks); }
    catch (e) { return partial("dropping stale git-hooks", e); }
    for (const name of droppedGitHooks) store.markUnapplied(plugin.manifest.name, { kind: "git-hook", name });
  }

  // 7) git-hooks LAST — install only records them; an update refreshes events already present in applied-state.
  if (fresh.gitHookTargets.some((g) => appliedGitHooks.has(g.event)) && gitState) {
    const selected = { ...plugin, gitHooks: plugin.gitHooks.filter((g) => appliedGitHooks.has(g.event)) };
    const err = await materializeGitHooks(selected, workspaceRoot, gitState, gitGeneration, git);
    if (err) return `partial install: payload + lockfile recorded, but git-hook activation failed (${err}) — run remove '${plugin.manifest.name}' to clean up, then retry`;
  }
  return undefined;
}

export async function applyInstall(plugin: LoadedPlugin, preview: InstallPreview, workspaceRoot: string, target: ReadonlySet<Runtime>, opts: ApplyOpts = {}): Promise<InstallResult> {
  if (preview.errors.length > 0) return { installed: false, runtimes: [], errors: preview.errors };

  // spec 264 — git-hook materialization needs git I/O: gather the (async) git state once, inject it into the
  // SYNC preview (TOCTOU re-derive), and reuse it for the materialization. Only when the plugin ships git-hooks.
  const git = opts.git ?? defaultGitRun;
  const gitState = plugin.gitHooks.length > 0 ? await gatherGitHookState(workspaceRoot, plugin.gitHooks.map((g) => g.event), git) : undefined;

  // spec 265 — gather the tool plan (resolved off the running host) and inject it into the SYNC preview, so the
  // TOCTOU re-derive + fingerprint cover the tools exactly as the consent drawer saw them.
  const hasTools = Object.keys(plugin.manifest.tools).length > 0;
  const toolPlan = hasTools ? await gatherToolPlan(plugin, { resolveFinalUrl: opts.resolveFinalUrl }) : undefined;
  const hasData = Object.keys(plugin.manifest.data).length > 0;
  const dataPlan = hasData ? await gatherDataPlan(plugin, { resolveFinalUrl: opts.resolveFinalUrl }) : undefined;

  const fresh = previewInstall(plugin, workspaceRoot, target, gitState, toolPlan, dataPlan);
  if (fresh.errors.length > 0) return { installed: false, runtimes: [], errors: fresh.errors };
  if (!fresh.fingerprint || fresh.fingerprint !== preview.fingerprint) {
    return { installed: false, runtimes: [], errors: ["workspace changed since preview — re-preview and re-consent before installing"] };
  }
  // PHASE 1 — fail-closed consent/ack gates.
  const gateErr = checkInstallAckGates(fresh, opts);
  if (gateErr) return { installed: false, runtimes: [], errors: [gateErr] };

  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { installed: false, runtimes: [], errors: lockRead.errors };
  const lockfile = lockRead.lockfile;

  // PHASE 2 — validate prior targets + resolve the consented Keep/Replace decisions + build the materialized set.
  const priorTargets = lockfile.plugins[plugin.manifest.name]?.targets ?? [];
  const priorGitHooks = lockfile.plugins[plugin.manifest.name]?.gitHooks ?? [];
  const priorErr = validatePriorTargets(plugin.manifest.name, priorTargets);
  if (priorErr) return { installed: false, runtimes: [], errors: [priorErr] };
  // the skill-dirs THIS plugin already owns (validated above) — authorize wiping our prior copy + drop stale dirs.
  const priorSkillDests = new Set(priorTargets.filter((t) => t.kind === "skill-dir").map((t) => t.file));

  const skillRes = resolveSkillWrites(fresh.skillTargets, opts.skillDecisions ?? {});
  if ("error" in skillRes) return { installed: false, runtimes: [], errors: [skillRes.error] };
  const skillsToWrite = skillRes.writes;

  const mcpRes = resolveMcpWrites(fresh.mcpTargets, opts.mcpDecisions ?? {});
  if ("error" in mcpRes) return { installed: false, runtimes: [], errors: [mcpRes.error] };
  const mcpToWrite = mcpRes.writes;

  // lost-update guard: every settings file must still match the consented snapshot BEFORE any write.
  for (const step of fresh.steps) {
    if (!settingsUnchanged(path.join(workspaceRoot, step.settingsRel), step.before)) {
      return { installed: false, runtimes: [], errors: [`${step.settingsRel} changed since preview — re-preview and re-consent`] };
    }
  }

  const { runtimes, targets } = buildInstallTargets(fresh, skillsToWrite, mcpToWrite, pluginPayloadAbs(workspaceRoot, plugin.manifest.name));
  if (runtimes.length === 0 && fresh.gitHookTargets.length === 0 && fresh.viewTargets.length === 0) {
    return { installed: false, runtimes: [], errors: ["nothing to install: every compatible skill/MCP server was kept and there are no hooks or views"] };
  }

  // spec 264 — the git-hook removal identity recorded in the lockfile (computed before the lockfile write so a
  // partial install is removable). The new ownership generation = current + 1.
  const gitGeneration = (gitState?.ownership?.generation ?? 0) + 1;
  const gitHookLocks: GitHookLock[] = fresh.gitHookTargets.map((g) => ({ event: g.event, managedLeafPath: `${GITHOOKS_REL}/leaves/${g.contentHash}`, leafContentHash: g.contentHash, ownershipGeneration: gitGeneration }));

  // spec 265 — PROVISION tools FIRST (download → verify → install into the live content-addressed store → smoke
  // → materialize the launcher), under a crash-safe transaction. Before any payload/settings mutation, so a tool
  // failure aborts cleanly (rollback removes just-installed unreferenced binaries). The locks + launcher are
  // committed into the lockfile below (with the rest), per gate (c): provision → commit → activate.
  let toolLocks: ToolLock[] = [];
  let launcherLock: LauncherLock | undefined;
  if (fresh.toolTargets.length > 0 && toolPlan) {
    const prov = await provisionTools(plugin.manifest.name, workspaceRoot, toolPlan, {
      toolConfirmed: opts.toolConfirmed,
      launcherBundlePath: opts.launcherBundlePath as string,
      nodePath: opts.nodePath,
      tlsCa: opts.toolTlsCa,
      existingLockfile: lockfile,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    if (prov.errors.length > 0) return { installed: false, runtimes: [], errors: prov.errors };
    toolLocks = prov.toolLocks;
    launcherLock = prov.launcher;
  }

  // spec 284 — PROVISION data artifacts (download → verify → install read-only → materialize the `_tachyon-data`
  // resolver), under the same crash-safe transaction. No execution, so a lighter ack than tools. The data shim
  // hashes merge into the workspace launcher record below.
  let dataLocks: DataLock[] = [];
  let dataResolver: { nodePath: string; dataShimSha256: string; dataValidatorSha256: string } | undefined;
  if (fresh.dataTargets.length > 0 && dataPlan) {
    const prov = await provisionData(plugin.manifest.name, workspaceRoot, dataPlan, {
      dataConfirmed: opts.dataConfirmed,
      resolverBundlePath: opts.dataResolverBundlePath as string,
      nodePath: opts.nodePath,
      tlsCa: opts.toolTlsCa,
      existingLockfile: lockfile,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    if (prov.errors.length > 0) return { installed: false, runtimes: [], errors: prov.errors };
    dataLocks = prov.dataLocks;
    dataResolver = prov.resolver;
  }

  // spec 285 — record the consented EXTERNAL-tool requirements + materialize the `_tachyon-external` resolver shim.
  // Nothing is provisioned/executed here (the assisted install is a separate, user-triggered terminal action).
  const externalReqs: ExternalToolReqLock[] = Object.entries(plugin.manifest.externalTools).map(([name, d]) => ({
    name,
    ...(d.names ? { names: d.names } : {}), // spec 289 — persist the candidate-name set so the runtime resolver tries the same
    ...(d.detect ? { detect: d.detect } : {}),
    install: Object.fromEntries(Object.entries(d.install).map(([pm, c]) => [pm, c.argv])),
    manual: d.manual,
  }));
  if (externalReqs.length > 0 && opts.externalResolverBundlePath) {
    const nodePath = opts.nodePath ?? process.execPath;
    const trust = isTrustedExecPath(nodePath, process.getuid?.() ?? 0, (p) => { try { return fs.statSync(p); } catch { return null; } });
    if (!trust.trusted) return { installed: false, runtimes: [], errors: [`external resolver Node '${nodePath}' is not trusted: ${trust.reason}`] };
    materializeExternalResolver(path.join(workspaceRoot, ".tachyon", "bin"), { nodePath, resolverBundlePath: opts.externalResolverBundlePath });
  }

  // 1) payload — copy to STAGING, re-preflight + hash-match the COPY, then promote (closes preflight→copy TOCTOU).
  const payloadDir = path.join(workspaceRoot, PAYLOAD_ROOT, plugin.manifest.name);
  const staging = `${payloadDir}.staging-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(path.dirname(payloadDir), { recursive: true });
  fs.cpSync(plugin.dir, staging, { recursive: true, dereference: false });
  const staged = preflightPayload(staging);
  if (staged.errors.length > 0 || staged.hash !== fresh.payloadHash) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { installed: false, runtimes: [], errors: ["plugin payload changed during install — re-preview and re-consent"] };
  }
  // spec 270 — preserve an existing human-edited config file across the payload swap: the human owns this file,
  // so an update/reinstall re-materializes the payload's default config but must NOT clobber their edits. Snapshot
  // the prior config bytes (if any) before the dir is replaced, and restore them onto the freshly-promoted payload.
  const cfgRel = plugin.manifest.config?.file;
  let preservedConfig: Buffer | undefined;
  if (cfgRel) {
    try { preservedConfig = fs.readFileSync(path.join(payloadDir, cfgRel)); } catch { /* first install — no prior config to keep */ }
  }
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.renameSync(staging, payloadDir);
  if (cfgRel && preservedConfig !== undefined) fs.writeFileSync(path.join(payloadDir, cfgRel), preservedConfig);

  // spec 263 — record the RUNTIME ancestor dirs this install is about to CREATE (those absent NOW), so a later
  // uninstall can `rmdir` exactly what it made and nothing it didn't. Computed HERE (just before the lockfile
  // write) because the dirs are created during activation (settings/skills/mcp writes below); the payload copy
  // above only touched `.tachyon/…`, which is never tracked. Any plan-affecting drift since preview was already
  // rejected by the fingerprint guard, so this LIVE-state stat is the authoritative did-not-pre-exist set.
  // Runtime materializations are now created by applyContribution, not install. Do not claim
  // ancestors that this install did not create.
  const createdAncestors: string[] = [];

  // 2) lockfile (uninstall identity). 3) settings LAST (activates the hooks). The lockfile records ALL
  // runtimes BEFORE any settings write, so if a later settings write fails the partial state is removable
  // (applyRemove un-merges every recorded runtime, including the one that didn't get activated → no-op there).
  lockfile.plugins[plugin.manifest.name] = {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    runtimes,
    targets,
    ...(createdAncestors.length > 0 ? { createdAncestors } : {}),
    ...(gitHookLocks.length > 0 ? { gitHooks: gitHookLocks } : {}),
    ...(toolLocks.length > 0 ? { tools: toolLocks } : {}),
    ...(dataLocks.length > 0 ? { data: dataLocks } : {}),
    ...(externalReqs.length > 0 ? { externalTools: externalReqs } : {}),
    ...(opts.provenance ? { source: opts.provenance.source, integrity: opts.provenance.integrity } : {}),
    // spec 270 — record the human-facing config + docs descriptor (workspace-relative payload paths) so the
    // lockfile-driven card can render Config/Docs without re-reading the manifest.
    ...(plugin.manifest.config
      ? { config: { file: `${PAYLOAD_ROOT}/${plugin.manifest.name}/${plugin.manifest.config.file}`, ...(plugin.manifest.config.schemaFile ? { schemaFile: `${PAYLOAD_ROOT}/${plugin.manifest.name}/${plugin.manifest.config.schemaFile}` } : {}) } }
      : {}),
    ...(plugin.manifest.docsUrl ? { docsUrl: plugin.manifest.docsUrl } : {}),
  };
  // spec 265/284 — the workspace-level resolver record: tool launcher hashes (from provisionTools) and/or the data
  // resolver hashes (from provisionData). MERGE against the existing record (codex HIGH) — refresh only the pair just
  // materialized, PRESERVE the surviving other pair (installing a data-only plugin into a tools workspace must not
  // drop the tool pair, and vice-versa).
  if (launcherLock || dataResolver) {
    const ex = lockfile.launcher;
    lockfile.launcher = {
      nodePath: launcherLock?.nodePath ?? dataResolver?.nodePath ?? ex!.nodePath,
      ...(launcherLock
        ? { shimSha256: launcherLock.shimSha256, validatorSha256: launcherLock.validatorSha256 }
        : (ex?.shimSha256 && ex.validatorSha256 ? { shimSha256: ex.shimSha256, validatorSha256: ex.validatorSha256 } : {})),
      ...(dataResolver
        ? { dataShimSha256: dataResolver.dataShimSha256, dataValidatorSha256: dataResolver.dataValidatorSha256 }
        : (ex?.dataShimSha256 && ex.dataValidatorSha256 ? { dataShimSha256: ex.dataShimSha256, dataValidatorSha256: ex.dataValidatorSha256 } : {})),
    };
  }
  writeLockfile(workspaceRoot, lockfile);

  // PHASE 6 — ACTIVATE: settings → skills → stale-skill cleanup → MCP → git-hooks (each removable on failure).
  const activateErr = await activateInstall({
    plugin,
    workspaceRoot,
    fresh,
    skillsToWrite,
    mcpToWrite,
    priorSkillDests,
    priorMcpTargets: priorTargets.filter((t) => t.kind === "mcp-server"),
    priorGitHooks,
    gitState,
    gitGeneration,
    git,
  });
  if (activateErr) return { installed: false, runtimes: [], errors: [activateErr] };

  return { installed: true, runtimes, errors: [] };
}

/** spec 264 — materialize a plugin's git-hooks under the repo lock: write each leaf to the content-addressed
 *  store, capture the prior hook on the FIRST claim, publish the merged snapshot + per-event dispatcher, update
 *  the repo-level ownership record, and set `core.hooksPath` LAST. Returns an error string on failure. */
async function materializeGitHooks(plugin: LoadedPlugin, workspaceRoot: string, gitState: GitHookState, generation: number, git: GitRun): Promise<string | undefined> {
  const store = new GitHookStore(workspaceRoot);
  const repo = new GitRepo(workspaceRoot, git);
  const owns = !!gitState.ownership && !!gitState.hooksPath && path.resolve(gitState.hooksPath.resolved) === path.resolve(workspaceRoot, gitState.ownership.managedPath);
  let release: (() => void) | undefined;
  try {
    release = await store.acquireLock();
    const replacingEvents = new Set(plugin.gitHooks.map((g) => g.event));
    // seed the new event set from the current snapshot (other plugins' leaves), dropping THIS plugin's prior
    // leaves (re-install/update replaces them). When not owned, start fresh.
    const events: Record<string, EventEntry> = {};
    const current = owns ? safeReadSnapshot(store) : undefined;
    if (current) for (const [ev, entry] of Object.entries(current.events)) {
      events[ev] = { priorHook: entry.priorHook, leaves: entry.leaves.filter((l) => l.pluginId !== plugin.manifest.name || !replacingEvents.has(ev)) };
    }
    const pid = plugin.manifest.name;
    for (const g of plugin.gitHooks) {
      const hash = store.putLeaf(g.content);
      const entry = events[g.event] ?? { priorHook: null, leaves: [] };
      // capture the prior hook on the first claim of this event (not owned, none captured yet).
      if (!owns && entry.priorHook === null) {
        const prior = gitState.priorHooks[g.event];
        if (prior) {
          const phHash = store.putLeaf(fs.readFileSync(prior.path));
          entry.priorHook = { contentHash: phHash, origin: { path: prior.path, mode: prior.mode, type: prior.type, ...(prior.symlinkTarget ? { symlinkTarget: prior.symlinkTarget } : {}) } };
        }
      }
      entry.leaves = [...entry.leaves.filter((l) => l.pluginId !== pid), { pluginId: pid, contentHash: hash, ...(g.argv ? { argv: g.argv } : {}) }].sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
      events[g.event] = entry;
    }
    store.writeSnapshot(generation, events);
    for (const [ev, entry] of Object.entries(events)) {
      const steps = [...(entry.priorHook ? [`leaves/${entry.priorHook.contentHash}`] : []), ...entry.leaves.map((l) => `leaves/${l.contentHash}`)];
      store.installEventArtifacts(ev, steps);
    }
    const leafRefs = Object.values(events).reduce((n, e) => n + e.leaves.length, 0);
    const managedPath = gitState.ownership?.managedPath ?? GITHOOKS_REL;
    const claimedFrom = gitState.ownership ? gitState.ownership.claimedFrom : (gitState.hooksPath?.raw ?? null);
    store.writeOwnership({ schema: 1, claimedFrom, managedPath, leafRefs, generation });
    if (!owns) await repo.setHooksPath(managedPath); // hooksPath set LAST
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    release?.();
  }
}

function safeReadSnapshot(store: GitHookStore) {
  try { return store.readSnapshot(); } catch { return undefined; }
}

/**
 * spec 264 — repair the git-hook claim after a clone. A clone carries the committed lockfile but NOT the
 * gitignored managed dir or `.git/config` (so `core.hooksPath` is unset and the gate is INERT until this runs).
 * Repair re-claims `core.hooksPath` ONLY when the managed state is intact on disk (ownership + snapshot present)
 * and hooksPath drifted; with no managed state it tells the caller to install by source (nothing to re-claim
 * silently). Explicit, consent-gated by the caller — never auto-claimed from a lockfile alone.
 */
export async function repairGitHooks(workspaceRoot: string, git: GitRun = defaultGitRun): Promise<{ repaired: boolean; reason: string }> {
  const store = new GitHookStore(workspaceRoot);
  const repo = new GitRepo(workspaceRoot, git);
  if (!(await repo.isWorkTree())) return { repaired: false, reason: "not a git repository" };
  let ownership; let snapshot;
  try {
    ownership = store.readOwnership();
    snapshot = safeReadSnapshot(store);
  } catch (e) {
    return { repaired: false, reason: `managed git-hook state is corrupt: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!ownership || !snapshot) return { repaired: false, reason: "no managed git-hook state on disk — install the plugin by source to (re)activate" };
  if (await repo.worktreeConfigEnabled()) return { repaired: false, reason: "extensions.worktreeConfig is enabled — Tachyon refuses to manage git hooks here" };
  const hooksPath = await repo.getHooksPath();
  if (hooksPath && path.resolve(hooksPath.resolved) === path.resolve(workspaceRoot, ownership.managedPath)) {
    return { repaired: false, reason: "already active" };
  }
  const release = await store.acquireLock();
  try {
    await repo.setHooksPath(ownership.managedPath);
  } finally {
    release();
  }
  return { repaired: true, reason: `re-claimed core.hooksPath → ${ownership.managedPath}` };
}

/** What `reconcileGitHookHarness` did, per event, so a caller can log or surface it. */
export interface GitHookHarnessReconcileReport {
  /** events whose dispatcher was brought forward to the current template. */
  refreshed: string[];
  /** events left alone because their stamp is NEWER than this engine's (a downgrade — never rewrite backwards). */
  ahead: string[];
  reason: string;
}

/**
 * t-c3b0a5 — bring a STALE generated harness forward to this engine's dispatcher template.
 *
 * The dispatcher is product code, not plugin content, but it was only ever written on plugin install/remove.
 * A dispatcher fix therefore reached nobody who already had the plugin installed: their workspace kept the
 * harness generated by the engine that installed it, indefinitely and silently. (That is how the t-6a8deb
 * stdin defect would have survived its own fix.)
 *
 * This rewrites ONLY the harness — dispatcher + execution manifest — from the leaves already recorded in the
 * published snapshot. It registers nothing, touches no leaf content and asks for no new consent: the leaves
 * and the `core.hooksPath` claim were consented to at install time, and this is the product correcting code
 * it generated itself. A stamp NEWER than this engine's (an engine downgrade) is left untouched: rewriting
 * backwards would silently strip whatever that newer harness was fixing.
 */
export async function reconcileGitHookHarness(workspaceRoot: string): Promise<GitHookHarnessReconcileReport> {
  const store = new GitHookStore(workspaceRoot);
  const none = (reason: string): GitHookHarnessReconcileReport => ({ refreshed: [], ahead: [], reason });
  let snapshot;
  try {
    if (!store.readOwnership()) return none("no managed git-hook state");
    // readSnapshot (NOT safeReadSnapshot): absent is `undefined`, corrupt THROWS. Collapsing the two here
    // would report tampered state as "nothing published" and hide it.
    snapshot = store.readSnapshot();
  } catch (e) {
    // Corrupt state is NOT ours to silently "fix" by regenerating over it — that is repair's decision.
    return none(`managed git-hook state is corrupt: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!snapshot) return none("no published git-hook snapshot");

  const stale: string[] = [];
  const ahead: string[] = [];
  for (const ev of Object.keys(snapshot.events)) {
    const onDisk = readDispatcherTemplateVersion(store.dispatcherFile(ev));
    if (onDisk === null) continue; // dispatcher absent/unreadable → install or repair owns that, not this
    if (onDisk < DISPATCHER_TEMPLATE_VERSION) stale.push(ev);
    else if (onDisk > DISPATCHER_TEMPLATE_VERSION) ahead.push(ev);
  }
  if (stale.length === 0) {
    return { refreshed: [], ahead, reason: ahead.length > 0 ? "harness is newer than this engine" : "harness is current" };
  }

  let release: (() => void) | undefined;
  try {
    release = await store.acquireLock();
    // Re-read under the lock: an install/remove may have republished (and refreshed) between check and claim.
    const fresh = store.readSnapshot();
    if (!fresh) return none("snapshot disappeared under the lock");
    const refreshed: string[] = [];
    for (const ev of stale) {
      const entry = fresh.events[ev];
      if (!entry) continue; // the event lost all its leaves meanwhile → removal already took the artifacts
      const nowOnDisk = readDispatcherTemplateVersion(store.dispatcherFile(ev));
      if (nowOnDisk === null || nowOnDisk >= DISPATCHER_TEMPLATE_VERSION) continue; // vanished or already refreshed
      const steps = [
        ...(entry.priorHook ? [`leaves/${entry.priorHook.contentHash}`] : []),
        ...entry.leaves.map((l) => `leaves/${l.contentHash}`),
      ];
      store.installEventArtifacts(ev, steps);
      refreshed.push(ev);
    }
    return {
      refreshed,
      ahead,
      reason: refreshed.length > 0
        ? `refreshed dispatcher template → v${DISPATCHER_TEMPLATE_VERSION} for: ${refreshed.join(", ")}`
        : "nothing stale under the lock",
    };
  } finally {
    release?.();
  }
}

/** spec 264 — un-register a plugin's git-hook leaves under the repo lock. When zero leaves remain across ALL
 *  events AND Tachyon still owns `core.hooksPath`, restore the recorded prior value (or unset) and tear down the
 *  managed dir; otherwise re-publish the snapshot (bumped generation) + dispatchers with the remaining leaves. */
async function removeGitHooks(lock: PluginLock, workspaceRoot: string, git: GitRun, onlyEvents?: ReadonlySet<string>): Promise<void> {
  if (!lock.gitHooks || lock.gitHooks.length === 0) return;
  const store = new GitHookStore(workspaceRoot);
  const repo = new GitRepo(workspaceRoot, git);
  let release: (() => void) | undefined;
  try {
    release = await store.acquireLock();
    const snapshot = safeReadSnapshot(store);
    if (!snapshot) return; // nothing managed (clone state / already removed) → no-op
    const pid = lock.name;
    const events: Record<string, EventEntry> = {};
    for (const [ev, entry] of Object.entries(snapshot.events)) {
      events[ev] = { priorHook: entry.priorHook, leaves: entry.leaves.filter((l) => l.pluginId !== pid || (onlyEvents !== undefined && !onlyEvents.has(ev))) };
    }
    // prune this plugin's leaf files no longer referenced by ANY remaining event.
    const stillReferenced = new Set<string>();
    for (const e of Object.values(events)) for (const l of e.leaves) stillReferenced.add(l.contentHash);
    for (const gh of lock.gitHooks) if ((!onlyEvents || onlyEvents.has(gh.event)) && !stillReferenced.has(gh.leafContentHash)) store.pruneLeaf(gh.leafContentHash);

    const leafRefs = Object.values(events).reduce((n, e) => n + e.leaves.length, 0);
    const ownership = store.readOwnership();
    const hooksPath = await repo.getHooksPath();
    const ownsManaged = !!ownership && !!hooksPath && path.resolve(hooksPath.resolved) === path.resolve(workspaceRoot, ownership.managedPath);

    if (leafRefs === 0) {
      // full teardown + restore: remove every dispatcher/manifest, the snapshot, the prior-hook leaves, ownership.
      for (const ev of Object.keys(snapshot.events)) store.removeEventArtifacts(ev);
      for (const e of Object.values(snapshot.events)) if (e.priorHook) store.pruneLeaf(e.priorHook.contentHash);
      store.removeSnapshot();
      store.removeOwnership();
      store.cleanupIfEmpty();
      if (ownsManaged) {
        const claimedFrom = ownership.claimedFrom;
        if (claimedFrom) await repo.setHooksPath(claimedFrom); // restore the user's prior hooksPath
        else await repo.unsetHooksPath();
      }
    } else {
      // other plugins remain: re-publish with the surviving leaves; drop any event that lost all its leaves.
      const newGen = (ownership?.generation ?? 0) + 1;
      for (const [ev, e] of Object.entries(events)) {
        if (e.leaves.length === 0) { delete events[ev]; store.removeEventArtifacts(ev); if (e.priorHook) store.pruneLeaf(e.priorHook.contentHash); }
      }
      store.writeSnapshot(newGen, events);
      for (const [ev, e] of Object.entries(events)) {
        const steps = [...(e.priorHook ? [`leaves/${e.priorHook.contentHash}`] : []), ...e.leaves.map((l) => `leaves/${l.contentHash}`)];
        store.installEventArtifacts(ev, steps);
      }
      store.writeOwnership({ schema: 1, claimedFrom: ownership?.claimedFrom ?? null, managedPath: ownership?.managedPath ?? GITHOOKS_REL, leafRefs, generation: newGen });
    }
  } finally {
    release?.();
  }
}

// ── remove (preview → apply) ────────────────────────────────────────────────

export interface RemovePreview {
  found: boolean;
  /** conservative orphans across all runtimes = recorded groups the user has since edited away. */
  orphans: number;
  removedCount: number;
  expectedCount: number;
  /** spec 251 — the number of skill-dirs this remove will delete. */
  skillCount: number;
  /** spec 254 — the number of MCP servers this remove will un-merge (content-aware; edited ones become orphans). */
  mcpCount: number;
  /** spec 264 — the number of git-hook leaves this remove will un-register. */
  gitHookCount: number;
  /** spec 349 — the number of view registrations this remove will revoke. Additive for older callers/tests. */
  viewCount?: number;
  /** a consent fingerprint over what will be un-merged (name+version+per-runtime current settings + owned
   *  groups + the skill-dirs deleted); applyRemove refuses a stale one so a remove never acts on a plan the
   *  user didn't see. "" when not found or on error. */
  fingerprint: string;
  errors: string[];
}

const SKILL_NAME_SEG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A skill-dir target is only legitimate if its file is EXACTLY `<runtime skillsRel>/<one kebab name>` — so a
 *  corrupted lockfile can't make `applyRemove` delete `package.json` or `.claude/` via a "contained" path. */
function validSkillDest(runtime: Runtime, file: string): boolean {
  const skillsRel = ADAPTERS[runtime].skillsRel;
  if (!skillsRel) return false;
  const prefix = `${skillsRel}/`;
  if (!file.startsWith(prefix)) return false;
  return SKILL_NAME_SEG.test(file.slice(prefix.length));
}

/** The skill-dir destination paths a plugin recorded (sorted, deterministic). Caller must have validated them. */
function skillDestsOf(lock: PluginLock): string[] {
  return lock.targets.filter((t) => t.kind === "skill-dir").map((t) => t.file).sort();
}

/** The mcp-server targets a plugin recorded (sorted by runtime+ref). Caller must have validated them. */
function mcpTargetsOf(lock: PluginLock): MaterializedTarget[] {
  return lock.targets
    .filter((t): t is MaterializedTarget & { runtime: Runtime; ref: string } => t.kind === "mcp-server" && !!t.runtime && typeof t.ref === "string")
    .sort((a, b) => (`${a.runtime} ${a.ref}` < `${b.runtime} ${b.ref}` ? -1 : 1));
}

function viewTargetsOf(lock: PluginLock): MaterializedTarget[] {
  return lock.targets.filter((t) => t.kind === "view").sort((a, b) => ((a.ref ?? "") < (b.ref ?? "") ? -1 : 1));
}

/** spec 263 — the runtime ancestor dirs a plugin recorded creating, VALIDATED against the known
 *  runtime-ancestor universe (a corrupted/hand-edited lockfile can never make remove `rmdir` an arbitrary
 *  path), deduped + sorted lexicographically. `applyRemove` re-sorts deepest-first for the actual rmdir. */
function createdAncestorsOf(lock: PluginLock): string[] {
  return [...new Set(lock.createdAncestors ?? [])].filter((p) => RUNTIME_ANCESTORS.has(p)).sort();
}

/** Fingerprint the exact remove plan: the lock identity + each runtime's current config + the owned groups
 *  + the skill-dirs deleted + the mcp servers un-merged (recorded removal AND the CURRENT on-disk entry — so a
 *  same-name server appearing/changing since the remove preview invalidates consent). */
function removeFingerprint(name: string, version: string, steps: RemoveStep[], skillDests: string[], mcpTargets: MaterializedTarget[], mcpCurrent: unknown[], viewTargets: MaterializedTarget[], createdAncestors: string[], gitHooks: GitHookLock[]): string {
  const basis = {
    name,
    version,
    steps: steps.map((s) => ({ rt: s.runtime, file: s.settingsRel, before: s.before, owned: s.owned })),
    skillDests,
    mcp: mcpTargets.map((t, i) => ({ rt: t.runtime, file: t.file, ref: t.ref, removal: t.removal, current: mcpCurrent[i] })),
    views: viewTargets.map((t) => ({ file: t.file, ref: t.ref })),
    // spec 263 — bind the recorded created-ancestors so the remove the user consented to includes exactly which
    // dirs uninstall will rmdir.
    createdAncestors,
    // spec 264 — bind the git-hook leaves this remove will un-register.
    gitHooks: gitHooks.map((g) => ({ event: g.event, hash: g.leafContentHash, gen: g.ownershipGeneration })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

/** The CURRENT on-disk representation of each recorded mcp target (parallel to `mcpTargets`), fail-closed:
 *  an unreadable/invalid MCP config is an error (never silently treated as "absent"). One read per file. */
function currentMcpReps(workspaceRoot: string, mcpTargets: MaterializedTarget[]): { current: unknown[]; errors: string[] } {
  const cache = new Map<string, { text?: string; error?: string }>();
  const errors: string[] = [];
  const current = mcpTargets.map((t) => {
    if (!t.runtime) throw new Error("internal: mcp target missing runtime after validation");
    if (!cache.has(t.file)) cache.set(t.file, readMcpConfig(workspaceRoot, t.runtime, t.file));
    const rd = cache.get(t.file) as { text?: string; error?: string };
    if (rd.error && !errors.includes(rd.error)) errors.push(rd.error);
    return currentMcp(t.runtime, rd.text, t.ref as string);
  });
  return { current, errors };
}

interface RemoveStep {
  runtime: Runtime;
  settingsRel: string;
  before: HookSettings;
  owned: OwnedHooks;
}

function planRemove(pluginName: string, workspaceRoot: string): { lockfile?: Lockfile; lock?: PluginLock; steps: RemoveStep[]; errors: string[] } {
  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { steps: [], errors: lockRead.errors };
  const lock = lockRead.lockfile.plugins[pluginName];
  if (!lock) return { lockfile: lockRead.lockfile, steps: [], errors: [] };

  // fail-closed: every recorded skill-dir / mcp-server target must be a legitimate path before we grant it
  // delete/un-merge authority (a corrupted/hand-edited lockfile must not turn remove into an arbitrary rm).
  for (const t of lock.targets) {
    if (t.kind === "skill-dir" && (!t.runtime || !validSkillDest(t.runtime, t.file))) {
      return { lockfile: lockRead.lockfile, lock, steps: [], errors: [`lockfile: skill-dir target '${t.file}' (${t.runtime}) is not a valid skills path`] };
    }
    if (t.kind === "mcp-server" && (!t.runtime || !validMcpDest(t.runtime, t.file) || typeof t.ref !== "string" || !MCP_SERVER_NAME.test(t.ref) || !validMcpRemoval(t.runtime, t.ref, t.removal))) {
      return { lockfile: lockRead.lockfile, lock, steps: [], errors: [`lockfile: mcp-server target '${t.file}' (${t.runtime}) is not a valid MCP config target`] };
    }
    if (t.kind === "view" && !validViewTarget(pluginName, t)) {
      return { lockfile: lockRead.lockfile, lock, steps: [], errors: [`lockfile: view target '${t.file}' is not a valid view target for '${pluginName}'`] };
    }
  }

  let appliedHooks: Set<string>;
  try { appliedHooks = new Set(new AppliedStateStore(workspaceRoot).appliedFor(pluginName).filter((r) => r.kind === "hook").map((r) => r.name)); }
  catch (e) { return { lockfile: lockRead.lockfile, lock, steps: [], errors: [e instanceof Error ? e.message : String(e)] }; }
  const steps: RemoveStep[] = [];
  for (const rt of lock.runtimes) {
    const spec = ADAPTERS[rt];
    const prior = priorOwned(lock, rt, spec.settingsRel);
    if (prior.errors.length > 0) return { lockfile: lockRead.lockfile, lock, steps: [], errors: prior.errors };
    prior.owned = Object.fromEntries(Object.entries(prior.owned).filter(([event]) => appliedHooks.has(event)));
    if (Object.keys(prior.owned).length === 0) continue;
    const read = readSettings(path.join(workspaceRoot, spec.settingsRel));
    if (!read.settings) return { lockfile: lockRead.lockfile, lock, steps: [], errors: read.errors };
    steps.push({ runtime: rt, settingsRel: spec.settingsRel, before: read.settings, owned: prior.owned });
  }
  return { lockfile: lockRead.lockfile, lock, steps, errors: [] };
}

/** Plan a remove WITHOUT writing — reports recorded-vs-orphan hook counts across all the plugin's runtimes. */
export function previewRemove(pluginName: string, workspaceRoot: string): RemovePreview {
  const plan = planRemove(pluginName, workspaceRoot);
  if (plan.errors.length > 0) return { found: !!plan.lock, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 0, mcpCount: 0, gitHookCount: 0, viewCount: 0, fingerprint: "", errors: plan.errors };
  if (!plan.lock) return { found: false, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 0, mcpCount: 0, gitHookCount: 0, viewCount: 0, fingerprint: "", errors: [] };
  let removedCount = 0;
  let expectedCount = 0;
  for (const step of plan.steps) {
    const r = removeHooks(step.before, step.owned);
    removedCount += r.removed ?? 0;
    expectedCount += r.expected ?? 0;
  }
  const skillDests = skillDestsOf(plan.lock);
  const mcpTargets = mcpTargetsOf(plan.lock);
  const viewTargets = viewTargetsOf(plan.lock);
  const gitHooks = plan.lock.gitHooks ?? [];
  const mcpCur = currentMcpReps(workspaceRoot, mcpTargets);
  if (mcpCur.errors.length > 0) return { found: true, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 0, mcpCount: 0, gitHookCount: 0, viewCount: 0, fingerprint: "", errors: mcpCur.errors };
  const fingerprint = removeFingerprint(pluginName, plan.lock.version, plan.steps, skillDests, mcpTargets, mcpCur.current, viewTargets, createdAncestorsOf(plan.lock), gitHooks);
  return { found: true, orphans: expectedCount - removedCount, removedCount, expectedCount, skillCount: skillDests.length, mcpCount: mcpTargets.length, gitHookCount: gitHooks.length, viewCount: viewTargets.length, fingerprint, errors: [] };
}

export interface RemoveResult {
  removed: boolean;
  orphans: number;
  errors: string[];
}

/** Remove a plugin across all its runtimes: un-merge exactly the recorded groups from each runtime's config
 *  (leaving user-edited groups as surfaced orphans), delete the payload, drop the lockfile entry. Fail-closed. */
export async function applyRemove(pluginName: string, workspaceRoot: string, opts: { expectedFingerprint?: string; git?: GitRun } = {}): Promise<RemoveResult> {
  const plan = planRemove(pluginName, workspaceRoot);
  if (plan.errors.length > 0) return { removed: false, orphans: 0, errors: plan.errors };
  if (!plan.lock || !plan.lockfile) return { removed: false, orphans: 0, errors: [`plugin '${pluginName}' is not installed`] };

  const skillDests = skillDestsOf(plan.lock);
  const mcpTargets = mcpTargetsOf(plan.lock);
  const viewTargets = viewTargetsOf(plan.lock);
  const ancestors = createdAncestorsOf(plan.lock);
  const mcpCur = currentMcpReps(workspaceRoot, mcpTargets);
  if (mcpCur.errors.length > 0) return { removed: false, orphans: 0, errors: mcpCur.errors };
  // consent binding (TOCTOU): refuse if the plugin changed (updated/reinstalled) OR a recorded MCP server
  // appeared/changed on disk since the remove was previewed.
  if (opts.expectedFingerprint !== undefined && removeFingerprint(pluginName, plan.lock.version, plan.steps, skillDests, mcpTargets, mcpCur.current, viewTargets, ancestors, plan.lock.gitHooks ?? []) !== opts.expectedFingerprint) {
    return { removed: false, orphans: 0, errors: ["workspace changed since preview — re-preview and re-consent before removing"] };
  }

  // lost-update guard for every runtime's config before any write.
  for (const step of plan.steps) {
    if (!settingsUnchanged(path.join(workspaceRoot, step.settingsRel), step.before)) {
      return { removed: false, orphans: 0, errors: [`${step.settingsRel} changed since the remove was planned — retry`] };
    }
  }

  let orphans = 0;
  for (const step of plan.steps) {
    const r = removeHooks(step.before, step.owned);
    if (!r.settings) return { removed: false, orphans: 0, errors: r.errors };
    writeSettings(path.join(workspaceRoot, step.settingsRel), r.settings);
    orphans += (r.expected ?? 0) - (r.removed ?? 0);
  }

  // delete each materialized skill-dir (exactly what Tachyon wrote; no backup/restore per D5).
  for (const dest of skillDests) {
    fs.rmSync(path.join(workspaceRoot, dest), { recursive: true, force: true });
  }

  // un-merge each recorded MCP server, content-aware: remove it only if the on-disk entry still equals what we
  // wrote; a server the user has since edited is left in place and counted as an orphan (never clobbered).
  // Phase C: a target that was never applied (and is absent on disk) is not an orphan — install no longer writes it.
  // Only consult applied-state when this plugin recorded MCP targets; a corrupt record must not block
  // uninstall of a hooks-only plugin.
  let appliedMcp = new Set<string>();
  if (mcpTargets.length > 0) {
    try {
      appliedMcp = new Set(new AppliedStateStore(workspaceRoot).appliedFor(pluginName).filter((r) => r.kind === "mcp").map((r) => r.name));
    } catch (e) {
      return { removed: false, orphans: 0, errors: [e instanceof Error ? e.message : String(e)] };
    }
  }
  const mcpByRuntime = new Map<Runtime, MaterializedTarget[]>();
  for (const t of mcpTargets) {
    if (!t.runtime) return { removed: false, orphans: 0, errors: ["internal: mcp target missing runtime after validation"] };
    mcpByRuntime.set(t.runtime, [...(mcpByRuntime.get(t.runtime) ?? []), t]);
  }
  for (const [rt, ts] of mcpByRuntime) {
    const mcpRel = ADAPTERS[rt].mcpRel;
    if (!mcpRel) continue;
    const file = path.join(workspaceRoot, mcpRel);
    const rd = readFile(file);
    let text: string | undefined = rd.missing ? undefined : rd.text;
    for (const t of ts) {
      const current = currentMcp(rt, text, t.ref as string);
      if (current === undefined && !appliedMcp.has(t.ref as string)) continue; // never applied, nothing to un-merge
      if (mcpRepEquals(current, t.removal)) text = removeMcpServerText(rt, text, t.ref as string);
      else orphans += 1;
    }
    writeMcpConfig(file, text ?? "");
  }

  fs.rmSync(path.join(workspaceRoot, PAYLOAD_ROOT, pluginName), { recursive: true, force: true });

  // spec 264 — un-register this plugin's git-hooks (restore core.hooksPath when we own the last leaf).
  await removeGitHooks(plan.lock, workspaceRoot, opts.git ?? defaultGitRun);

  delete plan.lockfile.plugins[pluginName];
  // spec 265 — drop this plugin's provisioned tools: delete each content-addressed FETCHED binary no surviving
  // plugin still references (physical refcount, H7); never a host-provided binary; remove the launcher when no
  // plugin has tools left.
  removeProvisionedTools(plan.lock, plan.lockfile, workspaceRoot);
  writeLockfile(workspaceRoot, plan.lockfile);
  // Phase C — drop this plugin from the applied record so a later re-install does not find MCP servers
  // already marked applied (t-17d885 residue). Best-effort: the plugin is already gone from the lockfile.
  try {
    new AppliedStateStore(workspaceRoot).forgetPlugin(pluginName);
  } catch {
    /* corrupt applied-state must not fail an otherwise-complete uninstall */
  }

  // spec 263 — last, tidy up the RUNTIME ancestor dirs THIS install created (now that their content is gone).
  // Non-recursive rmdir = the filesystem enforces "empty only" atomically (no TOCTOU): a dir that pre-existed,
  // still holds another plugin's files, or the user's own config is non-empty → ENOTEMPTY → safe no-op, never
  // an error. Deepest-first so a child (`.claude/skills`) is removed before its parent (`.claude`). Each path
  // was already validated against the runtime-ancestor universe by createdAncestorsOf. Best-effort: the plugin
  // is fully removed by now, so a leftover empty dir must never fail an otherwise-complete uninstall.
  const deepestFirst = [...ancestors].sort((a, b) => b.length - a.length || (a < b ? 1 : -1));
  for (const rel of deepestFirst) {
    try {
      fs.rmdirSync(path.join(workspaceRoot, rel));
    } catch {
      /* ENOENT (already gone) / ENOTEMPTY (not ours to remove) / any other → leave the dir in place */
    }
  }

  return { removed: true, orphans, errors: [] };
}

/** spec 265 — on uninstall, delete the removed plugin's FETCHED content-addressed binaries that NO surviving
 *  plugin references (physical identity), never a host-provided binary; and remove the workspace launcher when
 *  no plugin has tools left. Mutates `lockfileAfter` (drops `.launcher`). Best-effort fs ops. */
function removeProvisionedTools(removedLock: PluginLock, lockfileAfter: Lockfile, workspaceRoot: string): void {
  const binDir = path.join(workspaceRoot, ".tachyon", "bin");
  const remaining = toolReferenceCounts(lockfileAfter); // physical keys still referenced by surviving plugins
  for (const t of removedLock.tools ?? []) {
    if (t.source !== "fetched") continue; // never delete a host-provided binary
    if (remaining.has(physicalToolKey(t))) continue; // another plugin still references these exact bytes
    fs.rmSync(path.join(binDir, t.name, t.binSha256), { recursive: true, force: true });
    try { fs.rmdirSync(path.join(binDir, t.name)); } catch { /* non-empty (another sha) → keep */ }
  }
  // spec 284 — delete the removed plugin's DATA blobs that no surviving plugin references (physical identity).
  const remainingData = dataReferenceCounts(lockfileAfter);
  const dataDir = path.join(workspaceRoot, ".tachyon", "data", "sha256");
  for (const d of removedLock.data ?? []) {
    if (remainingData.has(physicalDataKey(d))) continue;
    fs.rmSync(path.join(dataDir, d.contentSha256), { recursive: true, force: true });
  }

  // drop each resolver shim when its KIND has no survivors; drop the launcher record only when NEITHER remains.
  const anyToolsLeft = Object.values(lockfileAfter.plugins).some((p) => (p.tools ?? []).length > 0);
  const anyDataLeft = Object.values(lockfileAfter.plugins).some((p) => (p.data ?? []).length > 0);
  if (!anyToolsLeft) {
    fs.rmSync(path.join(binDir, "_tachyon-tool"), { force: true });
    fs.rmSync(path.join(binDir, "_tachyon-tool.js"), { force: true });
  }
  if (!anyDataLeft) {
    fs.rmSync(path.join(binDir, "_tachyon-data"), { force: true });
    fs.rmSync(path.join(binDir, "_tachyon-data.js"), { force: true });
    try { fs.rmdirSync(dataDir); } catch { /* non-empty → keep */ }
    try { fs.rmdirSync(path.dirname(dataDir)); } catch { /* .tachyon/data non-empty → keep */ }
  }
  // spec 285 — drop the external resolver shim when no surviving plugin declares external tools (no blobs to free).
  const anyExternalLeft = Object.values(lockfileAfter.plugins).some((p) => (p.externalTools ?? []).length > 0);
  if (!anyExternalLeft) {
    fs.rmSync(path.join(binDir, "_tachyon-external"), { force: true });
    fs.rmSync(path.join(binDir, "_tachyon-external.js"), { force: true });
  }
  if (!anyToolsLeft && !anyDataLeft) {
    delete lockfileAfter.launcher;
    try { fs.rmdirSync(binDir); } catch { /* non-empty → keep */ }
  } else if (lockfileAfter.launcher) {
    const l = lockfileAfter.launcher;
    lockfileAfter.launcher = {
      nodePath: l.nodePath,
      ...(anyToolsLeft && l.shimSha256 && l.validatorSha256 ? { shimSha256: l.shimSha256, validatorSha256: l.validatorSha256 } : {}),
      ...(anyDataLeft && l.dataShimSha256 && l.dataValidatorSha256 ? { dataShimSha256: l.dataShimSha256, dataValidatorSha256: l.dataValidatorSha256 } : {}),
    };
  }
}

// ── apply / unapply (SDD 486 — skill-dir, settings-hook, mcp-server) ────────

export interface ApplyContributionResult {
  applied: boolean;
  errors: string[];
}

export interface UnapplyContributionResult {
  unapplied: boolean;
  orphans: number;
  errors: string[];
}

function mcpRefOf(ref: ContributionRef): string | undefined {
  return ref.kind === "mcp" ? ref.name : undefined;
}

/** The lockfile mcp-server targets for one contribution name, already shape-validated. */
function mcpTargetsFor(lock: PluginLock, name: string): MaterializedTarget[] {
  return mcpTargetsOf(lock).filter((t) => t.ref === name);
}

function skillTargetsFor(lock: PluginLock, name: string): MaterializedTarget[] {
  return lock.targets.filter((t) => t.kind === "skill-dir" && path.posix.basename(t.file) === name);
}

function hookTargetsFor(lock: PluginLock, name: string): MaterializedTarget[] {
  return lock.targets.filter((t) => t.kind === "settings-hook" && t.ref === name);
}

async function applyGitHookContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string, git: GitRun): Promise<ApplyContributionResult> {
  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { applied: false, errors: lockRead.errors };
  const lock = lockRead.lockfile.plugins[pluginName];
  if (!lock) return { applied: false, errors: [`plugin '${pluginName}' is not installed`] };
  if (!(lock.gitHooks ?? []).some((g) => g.event === ref.name)) return { applied: false, errors: [`plugin '${pluginName}' has no git-hook named '${ref.name}'`] };

  const loaded = loadPlugin(path.join(workspaceRoot, PAYLOAD_ROOT, pluginName));
  if (!loaded.plugin) return { applied: false, errors: loaded.errors };
  const hook = loaded.plugin.gitHooks.find((g) => g.event === ref.name);
  if (!hook) return { applied: false, errors: [`installed payload for '${pluginName}' has no git-hook named '${ref.name}'`] };
  const gitState = await gatherGitHookState(workspaceRoot, [ref.name], git);
  if (!gitState.isRepo) return { applied: false, errors: ["git-hook: not a git repository"] };
  if (gitState.worktreeConfig) return { applied: false, errors: ["git-hook: extensions.worktreeConfig is enabled — Tachyon refuses to manage git hooks here"] };
  const generation = (gitState.ownership?.generation ?? 0) + 1;
  const err = await materializeGitHooks({ ...loaded.plugin, gitHooks: [hook] }, workspaceRoot, gitState, generation, git);
  if (err) return { applied: false, errors: [err] };
  try { new AppliedStateStore(workspaceRoot).markApplied(pluginName, ref); }
  catch (e) { return { applied: false, errors: [e instanceof Error ? e.message : String(e)] }; }
  return { applied: true, errors: [] };
}

async function unapplyGitHookContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string, git: GitRun): Promise<UnapplyContributionResult> {
  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { unapplied: false, orphans: 0, errors: lockRead.errors };
  const lock = lockRead.lockfile.plugins[pluginName];
  if (!lock) return { unapplied: false, orphans: 0, errors: [`plugin '${pluginName}' is not installed`] };
  if (!(lock.gitHooks ?? []).some((g) => g.event === ref.name)) return { unapplied: false, orphans: 0, errors: [`plugin '${pluginName}' has no git-hook named '${ref.name}'`] };
  try {
    await removeGitHooks(lock, workspaceRoot, git, new Set([ref.name]));
    new AppliedStateStore(workspaceRoot).markUnapplied(pluginName, ref);
  } catch (e) {
    return { unapplied: false, orphans: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
  return { unapplied: true, orphans: 0, errors: [] };
}

/** Apply one contribution through the shared SDD 486 seam. Each kind resolves only its recorded
 * lockfile targets; MCP and hooks use their adapter-owned removal identity, while a skill copies the
 * installed payload directory. The applied record is marked only after every target is written. */
export function applyContribution(pluginName: string, ref: { kind: "git-hook"; name: string }, workspaceRoot: string, opts?: { replace?: boolean; git?: GitRun }): Promise<ApplyContributionResult>;
export function applyContribution(pluginName: string, ref: ContributionRef & { kind: Exclude<ContributionRef["kind"], "git-hook"> }, workspaceRoot: string, opts?: { replace?: boolean; git?: GitRun }): ApplyContributionResult;
export function applyContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string, opts?: { replace?: boolean; git?: GitRun }): ApplyContributionResult | Promise<ApplyContributionResult>;
export function applyContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string, opts: { replace?: boolean; git?: GitRun } = {}): ApplyContributionResult | Promise<ApplyContributionResult> {
  if (ref.kind === "git-hook") return applyGitHookContribution(pluginName, ref, workspaceRoot, opts.git ?? defaultGitRun);
  if (ref.kind === "skill") return applySkillContribution(pluginName, ref, workspaceRoot, opts);
  if (ref.kind === "hook") return applyHookContribution(pluginName, ref, workspaceRoot);
  const name = mcpRefOf(ref);
  if (!name) return { applied: false, errors: [`applyContribution: unsupported kind '${ref.kind}'`] };

  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { applied: false, errors: lockRead.errors };
  const lock = lockRead.lockfile.plugins[pluginName];
  if (!lock) return { applied: false, errors: [`plugin '${pluginName}' is not installed`] };

  const targets = mcpTargetsFor(lock, name);
  if (targets.length === 0) return { applied: false, errors: [`plugin '${pluginName}' has no mcp-server named '${name}'`] };

  for (const t of targets) {
    if (!t.runtime || !validMcpDest(t.runtime, t.file) || !validMcpRemoval(t.runtime, name, t.removal)) {
      return { applied: false, errors: [`lockfile: mcp-server target '${t.file}' (${t.runtime}) is not a valid MCP config target`] };
    }
  }

  // collision: a same-name server that is not our recorded removal is the user's — refuse unless replace.
  const byFile = new Map<string, { runtime: Runtime; text: string | undefined }>();
  for (const t of targets) {
    const rt = t.runtime as Runtime;
    if (!byFile.has(t.file)) {
      const rd = readMcpConfig(workspaceRoot, rt, t.file);
      if (rd.error) return { applied: false, errors: [rd.error] };
      byFile.set(t.file, { runtime: rt, text: rd.text });
    }
    const slot = byFile.get(t.file)!;
    const current = currentMcp(rt, slot.text, name);
    if (current !== undefined && !mcpRepEquals(current, t.removal) && opts.replace !== true) {
      return { applied: false, errors: [`MCP server '${name}' (${rt}) collides with an existing server in ${t.file}`] };
    }
  }

  try {
    for (const [fileRel, slot] of byFile) {
      let text = slot.text;
      for (const t of targets.filter((x) => x.file === fileRel)) {
        text = setMcpFromRemoval(slot.runtime, text, name, t.removal);
      }
      writeMcpConfig(path.join(workspaceRoot, fileRel), text ?? "");
    }
    new AppliedStateStore(workspaceRoot).markApplied(pluginName, ref);
  } catch (e) {
    return { applied: false, errors: [e instanceof AppliedStateError ? e.message : e instanceof Error ? e.message : String(e)] };
  }
  return { applied: true, errors: [] };
}

/**
 * Un-apply one contribution. Removes only the lockfile `removal` identity from each runtime config —
 * a human-edited same-name server is left in place and counted as an orphan. The payload stays.
 */
export function unapplyContribution(pluginName: string, ref: { kind: "git-hook"; name: string }, workspaceRoot: string, opts?: { git?: GitRun }): Promise<UnapplyContributionResult>;
export function unapplyContribution(pluginName: string, ref: ContributionRef & { kind: Exclude<ContributionRef["kind"], "git-hook"> }, workspaceRoot: string, opts?: { git?: GitRun }): UnapplyContributionResult;
export function unapplyContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string, opts?: { git?: GitRun }): UnapplyContributionResult | Promise<UnapplyContributionResult>;
export function unapplyContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string, opts: { git?: GitRun } = {}): UnapplyContributionResult | Promise<UnapplyContributionResult> {
  if (ref.kind === "git-hook") return unapplyGitHookContribution(pluginName, ref, workspaceRoot, opts.git ?? defaultGitRun);
  if (ref.kind === "skill") return unapplySkillContribution(pluginName, ref, workspaceRoot);
  if (ref.kind === "hook") return unapplyHookContribution(pluginName, ref, workspaceRoot);
  const name = mcpRefOf(ref);
  if (!name) return { unapplied: false, orphans: 0, errors: [`unapplyContribution: unsupported kind '${ref.kind}'`] };

  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { unapplied: false, orphans: 0, errors: lockRead.errors };
  const lock = lockRead.lockfile.plugins[pluginName];
  if (!lock) return { unapplied: false, orphans: 0, errors: [`plugin '${pluginName}' is not installed`] };

  const targets = mcpTargetsFor(lock, name);
  if (targets.length === 0) return { unapplied: false, orphans: 0, errors: [`plugin '${pluginName}' has no mcp-server named '${name}'`] };

  for (const t of targets) {
    if (!t.runtime || !validMcpDest(t.runtime, t.file) || !validMcpRemoval(t.runtime, name, t.removal)) {
      return { unapplied: false, orphans: 0, errors: [`lockfile: mcp-server target '${t.file}' (${t.runtime}) is not a valid MCP config target`] };
    }
  }

  let orphans = 0;
  try {
    const byFile = new Map<string, { runtime: Runtime; text: string | undefined }>();
    for (const t of targets) {
      const rt = t.runtime as Runtime;
      if (!byFile.has(t.file)) {
        const rd = readMcpConfig(workspaceRoot, rt, t.file);
        if (rd.error) return { unapplied: false, orphans: 0, errors: [rd.error] };
        byFile.set(t.file, { runtime: rt, text: rd.text });
      }
    }
    for (const [fileRel, slot] of byFile) {
      let text = slot.text;
      for (const t of targets.filter((x) => x.file === fileRel)) {
        const current = currentMcp(slot.runtime, text, name);
        if (current === undefined) continue; // already absent
        if (mcpRepEquals(current, t.removal)) text = removeMcpServerText(slot.runtime, text, name);
        else orphans += 1;
      }
      writeMcpConfig(path.join(workspaceRoot, fileRel), text ?? "");
    }
    new AppliedStateStore(workspaceRoot).markUnapplied(pluginName, ref);
  } catch (e) {
    return { unapplied: false, orphans: 0, errors: [e instanceof AppliedStateError ? e.message : e instanceof Error ? e.message : String(e)] };
  }
  return { unapplied: true, orphans, errors: [] };
}

function installedLock(pluginName: string, workspaceRoot: string): { lock?: PluginLock; errors: string[] } {
  const rd = readLockfile(workspaceRoot);
  if (!rd.lockfile) return { errors: rd.errors };
  const lock = rd.lockfile.plugins[pluginName];
  return lock ? { lock, errors: [] } : { errors: [`plugin '${pluginName}' is not installed`] };
}

function recordCreatedAncestors(pluginName: string, workspaceRoot: string, created: string[]): void {
  if (created.length === 0) return;
  const rd = readLockfile(workspaceRoot);
  const lock = rd.lockfile?.plugins[pluginName];
  if (!rd.lockfile || !lock) throw new Error(rd.errors[0] ?? `plugin '${pluginName}' is not installed`);
  lock.createdAncestors = [...new Set([...(lock.createdAncestors ?? []), ...created])].sort();
  writeLockfile(workspaceRoot, rd.lockfile);
}

function applySkillContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string, opts: { replace?: boolean }): ApplyContributionResult {
  const found = installedLock(pluginName, workspaceRoot);
  if (!found.lock) return { applied: false, errors: found.errors };
  const targets = skillTargetsFor(found.lock, ref.name);
  if (targets.length === 0) return { applied: false, errors: [`plugin '${pluginName}' has no skill named '${ref.name}'`] };
  for (const t of targets) if (!t.runtime || !validSkillDest(t.runtime, t.file)) return { applied: false, errors: [`lockfile: skill-dir target '${t.file}' (${t.runtime}) is not a valid skills path`] };
  const src = path.join(pluginPayloadAbs(workspaceRoot, pluginName), SKILLS_DIR, ref.name);
  if (!fs.existsSync(src)) return { applied: false, errors: [`installed payload has no skill directory '${ref.name}'`] };
  for (const t of targets) if (fs.existsSync(path.join(workspaceRoot, t.file)) && opts.replace !== true) return { applied: false, errors: [`skill '${ref.name}' collides with an existing skill at ${t.file}`] };
  const created = computeCreatedAncestors(workspaceRoot, targets.map((t) => t.file));
  try {
    for (const t of targets) {
      const dest = path.join(workspaceRoot, t.file);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true, dereference: false });
    }
    new AppliedStateStore(workspaceRoot).markApplied(pluginName, ref);
    recordCreatedAncestors(pluginName, workspaceRoot, created);
    return { applied: true, errors: [] };
  } catch (e) {
    return { applied: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

function unapplySkillContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string): UnapplyContributionResult {
  const found = installedLock(pluginName, workspaceRoot);
  if (!found.lock) return { unapplied: false, orphans: 0, errors: found.errors };
  const targets = skillTargetsFor(found.lock, ref.name);
  if (targets.length === 0) return { unapplied: false, orphans: 0, errors: [`plugin '${pluginName}' has no skill named '${ref.name}'`] };
  for (const t of targets) if (!t.runtime || !validSkillDest(t.runtime, t.file)) return { unapplied: false, orphans: 0, errors: [`lockfile: skill-dir target '${t.file}' (${t.runtime}) is not a valid skills path`] };
  try {
    for (const t of targets) fs.rmSync(path.join(workspaceRoot, t.file), { recursive: true, force: true });
    new AppliedStateStore(workspaceRoot).markUnapplied(pluginName, ref);
    return { unapplied: true, orphans: 0, errors: [] };
  } catch (e) {
    return { unapplied: false, orphans: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

function validatedHookTargets(lock: PluginLock, name: string): { targets?: Array<MaterializedTarget & { runtime: Runtime }>; error?: string } {
  const targets = hookTargetsFor(lock, name);
  if (targets.length === 0) return { error: `plugin '${lock.name}' has no hook named '${name}'` };
  for (const t of targets) {
    if (!t.runtime || t.file !== ADAPTERS[t.runtime].settingsRel) return { error: `lockfile: settings-hook target '${t.file}' (${t.runtime}) is not a valid settings path` };
    const parsed = parseOwnedHooks({ [name]: t.removal });
    if (!parsed.owned?.[name]) return { error: `lockfile: settings-hook '${name}' (${t.runtime}) has invalid removal identity` };
  }
  return { targets: targets as Array<MaterializedTarget & { runtime: Runtime }> };
}

function applyHookContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string): ApplyContributionResult {
  const found = installedLock(pluginName, workspaceRoot);
  if (!found.lock) return { applied: false, errors: found.errors };
  const checked = validatedHookTargets(found.lock, ref.name);
  if (!checked.targets) return { applied: false, errors: [checked.error as string] };
  const created = computeCreatedAncestors(workspaceRoot, checked.targets.map((t) => t.file));
  try {
    for (const t of checked.targets) {
      const file = path.join(workspaceRoot, t.file);
      const rd = readSettings(file);
      if (!rd.settings) return { applied: false, errors: rd.errors };
      const owned = { [ref.name]: t.removal } as OwnedHooks;
      const merged = mergeHooks(rd.settings, owned, pluginPayloadAbs(workspaceRoot, pluginName), owned);
      if (!merged.settings) return { applied: false, errors: merged.errors };
      writeSettings(file, merged.settings);
    }
    new AppliedStateStore(workspaceRoot).markApplied(pluginName, ref);
    recordCreatedAncestors(pluginName, workspaceRoot, created);
    return { applied: true, errors: [] };
  } catch (e) {
    return { applied: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

function unapplyHookContribution(pluginName: string, ref: ContributionRef, workspaceRoot: string): UnapplyContributionResult {
  const found = installedLock(pluginName, workspaceRoot);
  if (!found.lock) return { unapplied: false, orphans: 0, errors: found.errors };
  const checked = validatedHookTargets(found.lock, ref.name);
  if (!checked.targets) return { unapplied: false, orphans: 0, errors: [checked.error as string] };
  let orphans = 0;
  try {
    for (const t of checked.targets) {
      const file = path.join(workspaceRoot, t.file);
      const rd = readSettings(file);
      if (!rd.settings) return { unapplied: false, orphans: 0, errors: rd.errors };
      const removed = removeHooks(rd.settings, { [ref.name]: t.removal } as OwnedHooks);
      if (!removed.settings) return { unapplied: false, orphans: 0, errors: removed.errors };
      orphans += (removed.expected ?? 0) - (removed.removed ?? 0);
      writeSettings(file, removed.settings);
    }
    new AppliedStateStore(workspaceRoot).markUnapplied(pluginName, ref);
    return { unapplied: true, orphans, errors: [] };
  } catch (e) {
    return { unapplied: false, orphans: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

// ── update (3-way: baseline vs current vs new) ──────────────────────────────

export interface UpdateConflict {
  runtime: Runtime;
  settingsRel: string;
  /** baseline groups the user edited/removed since install (current ≠ baseline) — won't auto-update. */
  edited: number;
  /** groups the user ADDED that already equal a new-version group — installing would duplicate them. */
  collided: number;
}

export interface UpdatePreview {
  /** is the plugin currently installed? (if not, the caller should install, not update). */
  found: boolean;
  /** is the installed version already the plugin dir's version? */
  upToDate: boolean;
  /** is the plugin dir's version LOWER than the installed one? (a downgrade needs force). */
  isDowngrade: boolean;
  fromVersion?: string;
  toVersion: string;
  /**
   * t-4e5f11 — true when manifest versions match but the freshly resolved source payload hash differs from
   * the lockfile's `integrity.payload`. Distinct from a labeled version bump: the world moved, the version
   * label did not. Absent/false for every other outcome.
   */
  contentChangedSameVersion?: boolean;
  /** per-runtime conflicts (edited baseline and/or user-added collisions). */
  conflicts: UpdateConflict[];
  /** the install plan that would apply the new version (the merge with prior). Present when an update is possible. */
  install?: InstallPreview;
  errors: string[];
}

/** Optional inputs that let the freshness oracle see more than the manifest version (t-4e5f11). */
export interface PreviewUpdateOpts {
  /**
   * sha256 of the freshly resolved plugin payload (from `loadPluginFromSource` → `provenance.integrity.payload`).
   * When versions match, compared to `lock.integrity.payload`. Omit (or a lock without integrity) → version-only
   * back-compat for dir installs and pre-integrity locks.
   */
  payloadHash?: string;
}

/** Compare major.minor.patch numerically (prerelease ignored). Shares `compareSemver` with the tag comparator
 *  (spec 266) so the manifest-version and repo-tag ordering policies can never drift. <0 if a<b, 0 eq, >0 a>b. */
const compareVersions = compareSemver;

/**
 * Plan an update WITHOUT writing — a 3-way comparison: the lockfile records what was installed (baseline),
 * the on-disk config is what's there now (current), and the plugin dir is the new version. Two conflict
 * kinds (both refuse without force): a baseline group the user EDITED/removed (current ≠ baseline), and a
 * user-ADDED group that already equals a new-version group (installing would DUPLICATE it). A lower version
 * is flagged as a downgrade. Returns the conflicts + the install plan for the new version.
 *
 * Freshness oracle (t-4e5f11 / owner decision D): version is primary; when versions match, `integrity.payload`
 * breaks the tie (same version + different bytes ⇒ not up-to-date). Resolved commit is NOT compared — a monorepo
 * tag move would false-positive every sibling whose `#path=` payload is unchanged (spec 266).
 */
export async function previewUpdate(plugin: LoadedPlugin, workspaceRoot: string, git: GitRun = defaultGitRun, opts: PreviewUpdateOpts = {}): Promise<UpdatePreview> {
  const toVersion = plugin.manifest.version;
  const plan = planRemove(plugin.manifest.name, workspaceRoot); // prior owned + current settings per runtime
  if (plan.errors.length > 0) return { found: !!plan.lock, upToDate: false, isDowngrade: false, toVersion, conflicts: [], errors: plan.errors };
  if (!plan.lock) return { found: false, upToDate: false, isDowngrade: false, toVersion, conflicts: [], errors: [] };
  const fromVersion = plan.lock.version;

  // spec 263 — an update materializes into the SAME runtime set the user consented to at install (the
  // lockfile's `runtimes`), NOT detectRuntimes and NOT all-declared. If the NEW version drops a runtime the
  // install uses (`installedRuntimes ⊄ new manifest.runtimes`), refuse with an incompatible-runtime error — a
  // drift-repair update must never silently strip a runtime. The target is `lock.runtimes ∩ new manifest`,
  // which (once the subset check passes) equals `lock.runtimes`.
  const declared = new Set<Runtime>(plugin.manifest.runtimes);
  const dropped = plan.lock.runtimes.filter((rt) => !declared.has(rt));
  if (dropped.length > 0) {
    return { found: true, upToDate: false, isDowngrade: false, fromVersion, toVersion, conflicts: [], errors: [`'${plugin.manifest.name}' ${toVersion} no longer supports runtime(s) ${dropped.join(", ")} that the installed version uses — remove and reinstall to change the runtime set`] };
  }
  const target = new Set<Runtime>(plan.lock.runtimes);

  // t-4e5f11 — version match is no longer automatically fresh. When both the lock and the freshly resolved
  // source carry an integrity.payload and they differ, the source content changed under an unchanged version
  // label: fall through and build an install plan. Missing either side preserves version-only back-compat
  // (dir install, pre-integrity lock, caller that did not pass payloadHash).
  const lockedPayload = plan.lock.integrity?.payload;
  const nextPayload = opts.payloadHash;
  const contentChangedSameVersion =
    fromVersion === toVersion &&
    typeof lockedPayload === "string" &&
    lockedPayload.length > 0 &&
    typeof nextPayload === "string" &&
    nextPayload.length > 0 &&
    lockedPayload !== nextPayload;

  if (fromVersion === toVersion && !contentChangedSameVersion) {
    return { found: true, upToDate: true, isDowngrade: false, fromVersion, toVersion, conflicts: [], errors: [] };
  }

  const gitState = plugin.gitHooks.length > 0 ? await gatherGitHookState(workspaceRoot, plugin.gitHooks.map((g) => g.event), git) : undefined;
  const toolPlan = Object.keys(plugin.manifest.tools).length > 0 ? await gatherToolPlan(plugin) : undefined;
  const dataPlan = Object.keys(plugin.manifest.data).length > 0 ? await gatherDataPlan(plugin) : undefined;
  const install = previewInstall(plugin, workspaceRoot, target, gitState, toolPlan, dataPlan);
  const installByRt = new Map(install.steps.map((s) => [s.runtime, s]));

  const conflicts: UpdateConflict[] = [];
  for (const step of plan.steps) {
    // edited = baseline groups missing from current (count-aware). `leftover` = current with baseline removed.
    const removed = removeHooks(step.before, step.owned);
    const edited = (removed.expected ?? 0) - (removed.removed ?? 0);
    // collided = new-version groups the user has ALREADY added (present in leftover) → install would duplicate.
    const inst = installByRt.get(step.runtime);
    const collided = inst ? removeHooks(removed.settings ?? step.before, inst.owned).removed ?? 0 : 0;
    if (edited > 0 || collided > 0) conflicts.push({ runtime: step.runtime, settingsRel: step.settingsRel, edited, collided });
  }

  return {
    found: true,
    upToDate: false,
    // same-version content reapply is never a downgrade (versions equal).
    isDowngrade: contentChangedSameVersion ? false : compareVersions(toVersion, fromVersion) < 0,
    fromVersion,
    toVersion,
    ...(contentChangedSameVersion ? { contentChangedSameVersion: true } : {}),
    conflicts,
    install,
    errors: install.errors,
  };
}

export interface UpdateResult {
  updated: boolean;
  upToDate?: boolean;
  /** t-4e5f11 — echo of the preview flag so the panel toast can say "Reapplied" not "Updated". */
  contentChangedSameVersion?: boolean;
  conflicts?: UpdateConflict[];
  errors: string[];
}

/**
 * Apply an update. Refuses (without `force`) when (a) the user edited the installed plugin's hooks or added a
 * group that the new version would duplicate, or (b) the new version is a downgrade — so an update never
 * silently clobbers, duplicates, or rolls back. With `force`, proceeds with the install of the new version
 * (edited groups are left as conservative orphans — Tachyon never deletes a group the user edited).
 */
export async function applyUpdate(plugin: LoadedPlugin, workspaceRoot: string, opts: { force?: boolean; provenance?: InstallProvenance; expectedFingerprint?: string; skillDecisions?: Record<string, "keep" | "replace">; mcpDecisions?: Record<string, "keep" | "replace">; mcpConfirmed?: boolean; gitHookConfirmed?: boolean; toolConfirmed?: boolean; launcherBundlePath?: string; dataConfirmed?: boolean; dataResolverBundlePath?: string; externalResolverBundlePath?: string; viewConfirmed?: boolean; fleetReadConfirmed?: boolean; actionConfirmed?: Record<string, true>; nodePath?: string; toolTlsCa?: string | Buffer; onProgress?: ProvisionProgressFn; resolveFinalUrl?: (url: string) => Promise<string>; git?: GitRun } = {}): Promise<UpdateResult> {
  const git = opts.git ?? defaultGitRun;
  // t-4e5f11 — pass the freshly resolved payload hash so same-version content changes are not short-circuited.
  const preview = await previewUpdate(plugin, workspaceRoot, git, { payloadHash: opts.provenance?.integrity.payload });
  if (preview.errors.length > 0) return { updated: false, errors: preview.errors };
  if (!preview.found) return { updated: false, errors: [`plugin '${plugin.manifest.name}' is not installed — use install`] };
  if (preview.upToDate) return { updated: false, upToDate: true, errors: [] };
  // consent binding (TOCTOU): the freshly-computed plan must match the fingerprint the user consented to —
  // otherwise the workspace/source moved since the drawer was shown and we'd apply an UNCONSENTED plan.
  if (opts.expectedFingerprint !== undefined && preview.install?.fingerprint !== opts.expectedFingerprint) {
    return { updated: false, errors: ["workspace changed since preview — re-preview and re-consent before updating"] };
  }
  if (preview.isDowngrade && !opts.force) {
    return { updated: false, errors: [`'${plugin.manifest.name}' ${preview.toVersion} is lower than the installed ${preview.fromVersion} — re-run with force to downgrade`] };
  }
  if (preview.conflicts.length > 0 && !opts.force) {
    const where = preview.conflicts.map((c) => `${c.settingsRel}: ${c.edited} edited, ${c.collided} would-duplicate`).join("; ");
    return { updated: false, conflicts: preview.conflicts, errors: [`update would conflict with your changes (${where}); re-run with force to update anyway (your changed hooks are kept)`] };
  }
  if (!preview.install) return { updated: false, errors: ["nothing to apply"] };
  // spec 263 — apply into exactly the runtime set previewUpdate planned (the consented installed set, carried
  // on the preview), so applyInstall's TOCTOU re-derive matches and no runtime is silently added or dropped.
  const target = new Set<Runtime>(preview.install.targetRuntimes);
  const res = await applyInstall(plugin, preview.install, workspaceRoot, target, { provenance: opts.provenance, skillDecisions: opts.skillDecisions, mcpDecisions: opts.mcpDecisions, mcpConfirmed: opts.mcpConfirmed, gitHookConfirmed: opts.gitHookConfirmed, toolConfirmed: opts.toolConfirmed, launcherBundlePath: opts.launcherBundlePath, dataConfirmed: opts.dataConfirmed, dataResolverBundlePath: opts.dataResolverBundlePath, externalResolverBundlePath: opts.externalResolverBundlePath, viewConfirmed: opts.viewConfirmed, fleetReadConfirmed: opts.fleetReadConfirmed, actionConfirmed: opts.actionConfirmed, nodePath: opts.nodePath, toolTlsCa: opts.toolTlsCa, onProgress: opts.onProgress, resolveFinalUrl: opts.resolveFinalUrl, git });
  return {
    updated: res.installed,
    conflicts: preview.conflicts,
    errors: res.errors,
    ...(preview.contentChangedSameVersion ? { contentChangedSameVersion: true } : {}),
  };
}
