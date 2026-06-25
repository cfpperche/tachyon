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
import { loadManifest, resolveCompat, SUPPORTED_RUNTIMES, type PluginManifest, type Runtime } from "./manifest.js";
import {
  mergeHooks,
  removeHooks,
  parseOwnedHooks,
  normalizeHookSettings,
  type HooksBlock,
  type HookSettings,
  type OwnedHooks,
  type BlockParseResult,
} from "./adapters/hooks.js";
import { parseClaudeHooksBlock, renderClaudeMcpEntry } from "./adapters/claude.js";
import { parseCodexHooksBlock, renderCodexMcpBlock } from "./adapters/codex.js";
import {
  setClaudeMcpServer,
  removeClaudeMcpServer,
  getClaudeMcpServer,
  setCodexMcpServer,
  removeCodexMcpServer,
  getCodexMcpServerBlock,
} from "../registration/adapters.js";
import { parseSource } from "./source.js";
import { fetchSource, defaultGitRun, type GitRun } from "./fetcher.js";
import { parseSkillFrontmatter } from "./skill.js";
import { loadMcpPayload, type McpServer } from "./mcp.js";
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
} from "./lockfile.js";

const MANIFEST_REL = "tachyon-plugin.json";
const HOOKS_FILE = "hooks.json"; // inside a runtime block dir
const SKILLS_DIR = "skills"; // spec 251 — the plugin's neutral skills payload root
const SKILL_FILE = "SKILL.md"; // inside each skills/<name>/ dir
const MCP_FILE = "mcp.json"; // spec 254 — the plugin's neutral MCP-server payload (at the plugin root)
const PAYLOAD_ROOT = ".tachyon/plugins";

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

interface FileRead {
  text?: string;
  /** true ONLY for ENOENT — a genuinely absent file. Any other error (EACCES/EISDIR/…) is `error`, not absent. */
  missing: boolean;
  error?: string;
}

/** Read a file, distinguishing genuine absence (ENOENT) from an unreadable-but-present file (fail-closed). */
function readFile(file: string): FileRead {
  try {
    return { text: fs.readFileSync(file, "utf8"), missing: false };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    return { missing: false, error: `${code ?? "read error"}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Exported for the spec-263 temp-cleanup invariant test. Writes via a sibling temp + atomic rename; on ANY
 *  failure (write or rename) the temp file is cleaned up before rethrowing — otherwise a write that fails AFTER
 *  creating a fresh runtime dir would leave an orphan temp, making that dir non-empty and un-rmdir'able at
 *  uninstall (defeating spec-263 createdAncestors cleanup). */
export function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup; surface the original failure */
    }
    throw e;
  }
}

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

/** Which runtimes a workspace uses, by the presence of their config dir. */
export function detectRuntimes(workspaceRoot: string): Set<Runtime> {
  const present = new Set<Runtime>();
  if (fs.existsSync(path.join(workspaceRoot, ".claude"))) present.add("claude");
  if (fs.existsSync(path.join(workspaceRoot, ".codex"))) present.add("codex");
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

/** Read + validate a plugin directory: manifest + each runtime's hooks block (those it ships) + the neutral
 *  `skills/` payload. A plugin must carry AT LEAST ONE capability (hooks and/or skills). Fail-closed. */
export function loadPlugin(pluginDir: string): LoadResult {
  const manifestRead = readFile(path.join(pluginDir, MANIFEST_REL));
  if (manifestRead.error) return { errors: [`${MANIFEST_REL}: ${manifestRead.error}`] };
  if (manifestRead.missing) return { errors: [`no ${MANIFEST_REL} in ${pluginDir}`] };
  const { manifest, errors } = loadManifest(manifestRead.text as string);
  if (!manifest) return { errors };

  const plugin: LoadedPlugin = { dir: pluginDir, manifest, blocks: {}, rootRel: {}, skills: [], mcp: [] };

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

  if (Object.keys(plugin.blocks).length === 0 && plugin.skills.length === 0 && plugin.mcp.length === 0) {
    return { errors: [`${manifest.name}: a plugin must ship at least one capability (a runtime hooks block, a skill, and/or an MCP server)`] };
  }

  return { plugin, errors: [] };
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

// ── MCP config I/O helpers (runtime-generic: render via the Step-2 adapters, merge via the Step-3 writer) ──

/** A valid MCP server name (kebab) — also the lockfile `ref` and the config key. Mirrors mcp.ts SERVER_NAME_RE. */
const MCP_SERVER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Read a runtime's MCP config FAIL-CLOSED (mirrors readSettings): absent → undefined; unreadable, or (for
 *  claude) not valid JSON-object → ERROR. Never treats a broken/present config as "server absent" (which would
 *  let a merge clobber it or throw uncaught). */
function readMcpConfig(workspaceRoot: string, runtime: Runtime, rel: string): { text?: string; error?: string } {
  const rd = readFile(path.join(workspaceRoot, rel));
  if (rd.error) return { error: `${rel}: ${rd.error}` };
  if (rd.missing) return {};
  if (runtime === "claude") {
    try {
      const p: unknown = JSON.parse(rd.text as string);
      if (typeof p !== "object" || p === null || Array.isArray(p)) return { error: `${rel}: not a JSON object — refusing to overwrite` };
    } catch {
      return { error: `${rel}: invalid JSON — refusing to overwrite a broken config file` };
    }
  }
  return { text: rd.text };
}

/** The rendered representation of a server for `runtime` — the merged config entry AND the lockfile removal
 *  identity (claude: the `mcpServers.<name>` object; codex: the `[mcp_servers.<name>]` block text). */
function renderMcp(runtime: Runtime, server: McpServer): unknown {
  return runtime === "claude" ? renderClaudeMcpEntry(server) : renderCodexMcpBlock(server);
}

/** Merge a server into the runtime's MCP config text (render + place by name). */
function setMcpServer(runtime: Runtime, configText: string | undefined, server: McpServer): string {
  return runtime === "claude"
    ? setClaudeMcpServer(configText, server.name, renderClaudeMcpEntry(server))
    : setCodexMcpServer(configText, server.name, renderCodexMcpBlock(server));
}

/** Remove a server by name from the runtime's MCP config text. */
function removeMcpServerText(runtime: Runtime, configText: string | undefined, name: string): string {
  return runtime === "claude" ? removeClaudeMcpServer(configText, name) : removeCodexMcpServer(configText, name);
}

/** The current on-disk representation of server `name` (for content-aware removal: an edited server ≠ what we
 *  recorded → leave it as an orphan, never clobber a user's edit). */
function currentMcp(runtime: Runtime, configText: string | undefined, name: string): unknown {
  return runtime === "claude" ? getClaudeMcpServer(configText, name) : getCodexMcpServerBlock(configText, name);
}

/** Compare two rendered MCP representations (claude entry object / codex block string) structurally. */
function mcpRepEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Persist a runtime's MCP config text, deleting the file when it reduces to empty / `{}` (no Tachyon-only husk). */
function writeMcpConfig(file: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === "{}") fs.rmSync(file, { force: true });
  else atomicWrite(file, text);
}

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
  return typeof removal === "string" && removal.startsWith(`[mcp_servers.${ref}]`);
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

export interface InstallPreview {
  manifest: PluginManifest;
  steps: InstallStep[];
  /** the skill materializations this install would perform (across present, skills-capable runtimes). */
  skillTargets: SkillPlanItem[];
  /** the MCP-server materializations this install would perform (across present, MCP-capable runtimes). */
  mcpTargets: McpPlanItem[];
  /** per-MCP-config-file snapshot at preview (the lost-update basis re-verified before the step-6 write). */
  mcpConfigBefore: McpConfigSnapshot[];
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
}

function fingerprintOf(plugin: LoadedPlugin, targetRuntimes: Runtime[], steps: InstallStep[], skillTargets: SkillPlanItem[], mcpTargets: McpPlanItem[], mcpConfigBefore: McpConfigSnapshot[], payloadHash: string): string {
  const basis = {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    payload: payloadHash,
    // spec 263 — the consented runtime selection, bound EXPLICITLY (not "for free"): a declared runtime with no
    // per-runtime artifact contributes nothing to steps/skills/mcp, so select-vs-deselect would otherwise hash
    // identically. Normalized + sorted upstream for stability.
    targetRuntimes,
    steps: steps.map((s) => ({ rt: s.runtime, before: s.before, after: s.after })),
    // bind the skill plan + which dests collide (a changed collision set must invalidate consent).
    skills: skillTargets.map((s) => ({ rt: s.runtime, dest: s.destRel, collision: s.collision })),
    // bind the MCP plan: rendered entry (a payload edit changes it) + the CURRENT on-disk entry + collision —
    // so a same-name server appearing/changing since consent invalidates the fingerprint.
    mcp: mcpTargets.map((m) => ({ rt: m.runtime, ref: m.ref, entry: renderMcp(m.runtime, m.server), current: m.current, collision: m.collision })),
    // bind each MCP config file snapshot (the lost-update basis): ANY change to the file invalidates consent.
    mcpConfig: mcpConfigBefore.map((c) => ({ rt: c.runtime, dest: c.destRel, text: c.text })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

/** Plan an install WITHOUT writing: preflight payload, read each runtime's config + the lockfile fail-closed,
 *  compute the merges, return the diff + wired commands + a consent fingerprint. */
export function previewInstall(plugin: LoadedPlugin, workspaceRoot: string, target: ReadonlySet<Runtime>): InstallPreview {
  const { manifest } = plugin;
  const empty = (errors: string[]): InstallPreview => ({ manifest, steps: [], skillTargets: [], mcpTargets: [], mcpConfigBefore: [], targetRuntimes: [], skipped: [], warnings: [], errors, fingerprint: "", payloadHash: "" });

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

  for (const rt of compat.installable) {
    const spec = ADAPTERS[rt];
    const block = plugin.blocks[rt];
    const rootRel = plugin.rootRel[rt];
    if (!block || !rootRel) {
      warnings.push(`${rt}: plugin declares ${rt} but carries no hooks — nothing to wire`);
      continue;
    }
    const prior = priorOwned(lock, rt, spec.settingsRel);
    if (prior.errors.length > 0) return empty(prior.errors);
    const read = readSettings(path.join(workspaceRoot, spec.settingsRel));
    if (!read.settings) {
      errors.push(...read.errors);
      continue;
    }
    const merge = mergeHooks(read.settings, block, rootRel, prior.owned);
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
  const priorMcpTargets = (lock?.targets ?? []).filter((t) => t.kind === "mcp-server");
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

  const fingerprint = errors.length > 0 ? "" : fingerprintOf(plugin, targetRuntimes, steps, skillTargets, mcpTargets, mcpConfigBefore, payload.hash);
  return { manifest, steps, skillTargets, mcpTargets, mcpConfigBefore, targetRuntimes, skipped, warnings, errors, fingerprint, payloadHash: payload.hash };
}

export interface InstallResult {
  installed: boolean;
  runtimes: Runtime[];
  errors: string[];
}

/** Apply a previewed install: re-derive + refuse a stale preview (TOCTOU), then write payload → lockfile →
 *  settings, staging + hash-checking the payload copy and lost-update-checking each settings file first. */
export function applyInstall(plugin: LoadedPlugin, preview: InstallPreview, workspaceRoot: string, target: ReadonlySet<Runtime>, opts: { provenance?: InstallProvenance; skillDecisions?: Record<string, "keep" | "replace">; mcpDecisions?: Record<string, "keep" | "replace">; mcpConfirmed?: boolean } = {}): InstallResult {
  if (preview.errors.length > 0) return { installed: false, runtimes: [], errors: preview.errors };

  const fresh = previewInstall(plugin, workspaceRoot, target);
  if (fresh.errors.length > 0) return { installed: false, runtimes: [], errors: fresh.errors };
  if (!fresh.fingerprint || fresh.fingerprint !== preview.fingerprint) {
    return { installed: false, runtimes: [], errors: ["workspace changed since preview — re-preview and re-consent before installing"] };
  }
  if (fresh.steps.length === 0 && fresh.skillTargets.length === 0 && fresh.mcpTargets.length === 0) {
    return { installed: false, runtimes: [], errors: ["nothing to install: no hooks, skills, or MCP servers for any present runtime"] };
  }
  // OQ5 — an MCP server is agent-invokable process/network authority, so its consent is FAIL-CLOSED at the
  // engine (not just the drawer's disabled button): any plan that touches MCP requires the explicit second
  // confirmation. A non-UI caller (raw message / direct engine use) can't install MCP without it.
  if (fresh.mcpTargets.length > 0 && opts.mcpConfirmed !== true) {
    return { installed: false, runtimes: [], errors: ["MCP servers require the consent drawer's MCP acknowledgement — re-open and confirm before installing"] };
  }

  const lockRead = readLockfile(workspaceRoot);
  if (!lockRead.lockfile) return { installed: false, runtimes: [], errors: lockRead.errors };
  const lockfile = lockRead.lockfile;
  // fail-closed (symmetric with planRemove): a corrupted prior skill-dir target must not be trusted — it could
  // otherwise suppress a real collision OR get deleted by stale-cleanup (e.g. a forged `.claude/settings.json`).
  const priorTargets = lockfile.plugins[plugin.manifest.name]?.targets ?? [];
  for (const t of priorTargets) {
    if (t.kind === "skill-dir" && !validSkillDest(t.runtime, t.file)) {
      return { installed: false, runtimes: [], errors: [`lockfile: skill-dir target '${t.file}' (${t.runtime}) is not a valid skills path — fix the lockfile before installing`] };
    }
    if (t.kind === "mcp-server" && (!validMcpDest(t.runtime, t.file) || typeof t.ref !== "string" || !MCP_SERVER_NAME.test(t.ref) || !validMcpRemoval(t.runtime, t.ref, t.removal))) {
      return { installed: false, runtimes: [], errors: [`lockfile: mcp-server target '${t.file}' (${t.runtime}) is not a valid MCP config path — fix the lockfile before installing`] };
    }
  }
  // the skill-dirs THIS plugin already owns (validated above) — used to (a) authorize wiping our own prior copy
  // and (b) clean up stale dirs an update dropped.
  const priorSkillDests = new Set(priorTargets.filter((t) => t.kind === "skill-dir").map((t) => t.file));

  // resolve each colliding skill against the consented Keep/Replace decision (fail-closed: an undecided
  // collision refuses — we never silently overwrite a user's skill or silently skip a consented one).
  const decisions = opts.skillDecisions ?? {};
  const skillsToWrite: Array<SkillPlanItem & { replace: boolean }> = [];
  for (const st of fresh.skillTargets) {
    if (st.collision) {
      const d = decisions[st.destRel];
      if (d === undefined) return { installed: false, runtimes: [], errors: [`skill '${st.skill}' (${st.runtime}) collides with an existing skill at ${st.destRel} — choose Keep or Replace and re-consent`] };
      if (d === "keep") continue; // leave the user's skill in place; do not materialize or record it
      skillsToWrite.push({ ...st, replace: true }); // consented overwrite
    } else {
      skillsToWrite.push({ ...st, replace: false }); // clean write (no existing user skill at consent time)
    }
  }

  // resolve each colliding MCP server against the consented Keep/Replace (fail-closed, like skills). A Kept
  // collision is neither merged nor recorded (the user's server stays); a clean/Replace one is written.
  const mcpDecisions = opts.mcpDecisions ?? {};
  const mcpToWrite: McpPlanItem[] = [];
  for (const mt of fresh.mcpTargets) {
    if (mt.collision) {
      const d = mcpDecisions[`${mt.runtime} ${mt.ref}`];
      if (d === undefined) return { installed: false, runtimes: [], errors: [`MCP server '${mt.ref}' (${mt.runtime}) collides with an existing server in ${mt.destRel} — choose Keep or Replace and re-consent`] };
      if (d === "keep") continue;
      mcpToWrite.push(mt); // consented overwrite
    } else {
      mcpToWrite.push(mt);
    }
  }

  // lost-update guard: every settings file must still match the consented snapshot BEFORE any write.
  for (const step of fresh.steps) {
    if (!settingsUnchanged(path.join(workspaceRoot, step.settingsRel), step.before)) {
      return { installed: false, runtimes: [], errors: [`${step.settingsRel} changed since preview — re-preview and re-consent`] };
    }
  }

  const runtimes: Runtime[] = [];
  const targets: MaterializedTarget[] = [];
  for (const step of fresh.steps) {
    for (const [event, groups] of Object.entries(step.owned)) {
      targets.push({ runtime: step.runtime, kind: "settings-hook", file: step.settingsRel, ref: event, removal: groups });
    }
    runtimes.push(step.runtime);
  }
  // skill-dir targets (recorded for precise removal); a runtime gains it even with no hooks.
  for (const st of skillsToWrite) {
    targets.push({ runtime: st.runtime, kind: "skill-dir", file: st.destRel });
    if (!runtimes.includes(st.runtime)) runtimes.push(st.runtime);
  }
  // mcp-server targets — `ref` = server name (the config key), `removal` = the rendered entry/block (the
  // content-aware un-merge identity: remove only if the on-disk server still matches, else leave as an orphan).
  for (const mt of mcpToWrite) {
    targets.push({ runtime: mt.runtime, kind: "mcp-server", file: mt.destRel, ref: mt.ref, removal: renderMcp(mt.runtime, mt.server) });
    if (!runtimes.includes(mt.runtime)) runtimes.push(mt.runtime);
  }
  if (runtimes.length === 0) {
    return { installed: false, runtimes: [], errors: ["nothing to install: every compatible skill/MCP server was kept and there are no hooks"] };
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
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.renameSync(staging, payloadDir);

  // spec 263 — record the RUNTIME ancestor dirs this install is about to CREATE (those absent NOW), so a later
  // uninstall can `rmdir` exactly what it made and nothing it didn't. Computed HERE (just before the lockfile
  // write) because the dirs are created during activation (settings/skills/mcp writes below); the payload copy
  // above only touched `.tachyon/…`, which is never tracked. Any plan-affecting drift since preview was already
  // rejected by the fingerprint guard, so this LIVE-state stat is the authoritative did-not-pre-exist set.
  const createdAncestors = computeCreatedAncestors(workspaceRoot, [...fresh.steps.map((s) => s.settingsRel), ...skillsToWrite.map((s) => s.destRel), ...mcpToWrite.map((m) => m.destRel)]);

  // 2) lockfile (uninstall identity). 3) settings LAST (activates the hooks). The lockfile records ALL
  // runtimes BEFORE any settings write, so if a later settings write fails the partial state is removable
  // (applyRemove un-merges every recorded runtime, including the one that didn't get activated → no-op there).
  lockfile.plugins[plugin.manifest.name] = {
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    runtimes,
    targets,
    ...(createdAncestors.length > 0 ? { createdAncestors } : {}),
    ...(opts.provenance ? { source: opts.provenance.source, integrity: opts.provenance.integrity } : {}),
  };
  writeLockfile(workspaceRoot, lockfile);
  for (const step of fresh.steps) {
    try {
      writeSettings(path.join(workspaceRoot, step.settingsRel), step.after);
    } catch (e) {
      return {
        installed: false,
        runtimes: [],
        errors: [`partial install: payload + lockfile recorded, but writing ${step.settingsRel} failed (${e instanceof Error ? e.message : String(e)}) — run remove '${plugin.manifest.name}' to clean up, then retry`],
      };
    }
  }

  // 4) skills — copy each (consented) skill from the committed payload to its runtime's skills dir. The lockfile
  // already records these skill-dir targets, so a mid-write failure is removable. A Replace destination is wiped
  // first (the user consented to the overwrite via the drawer's double confirmation); our own prior copy too.
  for (const st of skillsToWrite) {
    const destAbs = path.join(workspaceRoot, st.destRel);
    const srcAbs = path.join(workspaceRoot, st.srcRel);
    // TOCTOU guard: a CLEAN write (no collision at consent time) must never wipe a dir that has APPEARED since
    // — only our own prior copy or a consented Replace may be overwritten. A new occupant → fail closed.
    if (!st.replace && !priorSkillDests.has(st.destRel) && fs.existsSync(destAbs)) {
      return { installed: false, runtimes: [], errors: [`skill destination ${st.destRel} appeared since preview — re-preview and re-consent`] };
    }
    try {
      fs.rmSync(destAbs, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.cpSync(srcAbs, destAbs, { recursive: true, dereference: false });
    } catch (e) {
      return {
        installed: false,
        runtimes: [],
        errors: [`partial install: payload + lockfile recorded, but writing skill '${st.skill}' to ${st.destRel} failed (${e instanceof Error ? e.message : String(e)}) — run remove '${plugin.manifest.name}' to clean up, then retry`],
      };
    }
  }

  // 5) update cleanup — delete skill-dirs THIS plugin owned before but its new version no longer ships
  // (e.g. a renamed/removed skill). The lockfile now records only the new set, so this is the only chance to
  // remove the stale dir; a Kept user-collision is never in priorSkillDests, so it's never touched here.
  const newSkillDests = new Set(skillsToWrite.map((s) => s.destRel));
  for (const old of priorSkillDests) {
    if (!newSkillDests.has(old)) fs.rmSync(path.join(workspaceRoot, old), { recursive: true, force: true });
  }

  // 6) MCP servers — merge each consented server into its runtime's config; clean up servers THIS plugin owned
  // before but the new version dropped. Content-aware: a server the user edited away from what we recorded is
  // left as an orphan, never clobbered. (Tachyon writes the entry only; each runtime's own MCP approval gates
  // actually running it — OQ6.)
  const priorMcpTargets2 = priorTargets.filter((t) => t.kind === "mcp-server");
  const mcpBefore = new Map(fresh.mcpConfigBefore.map((c) => [c.destRel, c.text]));
  const mcpRuntimes = new Set<Runtime>([...mcpToWrite.map((m) => m.runtime), ...priorMcpTargets2.map((t) => t.runtime)]);
  for (const rt of mcpRuntimes) {
    const mcpRel = ADAPTERS[rt].mcpRel;
    if (!mcpRel) continue;
    const file = path.join(workspaceRoot, mcpRel);
    // lost-update guard (mirror settingsUnchanged for hooks): the config must still equal the consented
    // snapshot — fail-closed read, then a same-text check — so a server added/changed since preview can't be
    // silently clobbered. A snapshot is present for every dest in the plan; absent (a prior-only stale-cleanup
    // dest) ⇒ skip the equality check but still read fail-closed.
    const rd = readMcpConfig(workspaceRoot, rt, mcpRel);
    if (rd.error) return { installed: false, runtimes: [], errors: [`partial install: payload + lockfile recorded, but ${rd.error} — run remove '${plugin.manifest.name}' to clean up, then retry`] };
    if (mcpBefore.has(mcpRel) && (rd.text ?? null) !== mcpBefore.get(mcpRel)) {
      return { installed: false, runtimes: [], errors: [`${mcpRel} changed since preview — re-preview and re-consent before installing`] };
    }
    let text = rd.text;
    const writeRefs = new Set(mcpToWrite.filter((m) => m.runtime === rt).map((m) => m.ref));
    try {
      for (const t of priorMcpTargets2) {
        if (t.runtime !== rt || !t.ref || writeRefs.has(t.ref)) continue;
        if (mcpRepEquals(currentMcp(rt, text, t.ref), t.removal)) text = removeMcpServerText(rt, text, t.ref);
      }
      for (const m of mcpToWrite.filter((x) => x.runtime === rt)) text = setMcpServer(rt, text, m.server);
      writeMcpConfig(file, text ?? "");
    } catch (e) {
      return { installed: false, runtimes: [], errors: [`partial install: payload + lockfile recorded, but writing ${mcpRel} failed (${e instanceof Error ? e.message : String(e)}) — run remove '${plugin.manifest.name}' to clean up, then retry`] };
    }
  }

  return { installed: true, runtimes, errors: [] };
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
    .filter((t) => t.kind === "mcp-server")
    .sort((a, b) => (`${a.runtime} ${a.ref}` < `${b.runtime} ${b.ref}` ? -1 : 1));
}

/** Fingerprint the exact remove plan: the lock identity + each runtime's current config + the owned groups
 *  + the skill-dirs deleted + the mcp servers un-merged (recorded removal AND the CURRENT on-disk entry — so a
 *  same-name server appearing/changing since the remove preview invalidates consent). */
function removeFingerprint(name: string, version: string, steps: RemoveStep[], skillDests: string[], mcpTargets: MaterializedTarget[], mcpCurrent: unknown[]): string {
  const basis = {
    name,
    version,
    steps: steps.map((s) => ({ rt: s.runtime, file: s.settingsRel, before: s.before, owned: s.owned })),
    skillDests,
    mcp: mcpTargets.map((t, i) => ({ rt: t.runtime, file: t.file, ref: t.ref, removal: t.removal, current: mcpCurrent[i] })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

/** The CURRENT on-disk representation of each recorded mcp target (parallel to `mcpTargets`), fail-closed:
 *  an unreadable/invalid MCP config is an error (never silently treated as "absent"). One read per file. */
function currentMcpReps(workspaceRoot: string, mcpTargets: MaterializedTarget[]): { current: unknown[]; errors: string[] } {
  const cache = new Map<string, { text?: string; error?: string }>();
  const errors: string[] = [];
  const current = mcpTargets.map((t) => {
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
    if (t.kind === "skill-dir" && !validSkillDest(t.runtime, t.file)) {
      return { lockfile: lockRead.lockfile, lock, steps: [], errors: [`lockfile: skill-dir target '${t.file}' (${t.runtime}) is not a valid skills path`] };
    }
    if (t.kind === "mcp-server" && (!validMcpDest(t.runtime, t.file) || typeof t.ref !== "string" || !MCP_SERVER_NAME.test(t.ref) || !validMcpRemoval(t.runtime, t.ref, t.removal))) {
      return { lockfile: lockRead.lockfile, lock, steps: [], errors: [`lockfile: mcp-server target '${t.file}' (${t.runtime}) is not a valid MCP config target`] };
    }
  }

  const steps: RemoveStep[] = [];
  for (const rt of lock.runtimes) {
    const spec = ADAPTERS[rt];
    const prior = priorOwned(lock, rt, spec.settingsRel);
    if (prior.errors.length > 0) return { lockfile: lockRead.lockfile, lock, steps: [], errors: prior.errors };
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
  if (plan.errors.length > 0) return { found: !!plan.lock, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 0, mcpCount: 0, fingerprint: "", errors: plan.errors };
  if (!plan.lock) return { found: false, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 0, mcpCount: 0, fingerprint: "", errors: [] };
  let removedCount = 0;
  let expectedCount = 0;
  for (const step of plan.steps) {
    const r = removeHooks(step.before, step.owned);
    removedCount += r.removed ?? 0;
    expectedCount += r.expected ?? 0;
  }
  const skillDests = skillDestsOf(plan.lock);
  const mcpTargets = mcpTargetsOf(plan.lock);
  const mcpCur = currentMcpReps(workspaceRoot, mcpTargets);
  if (mcpCur.errors.length > 0) return { found: true, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 0, mcpCount: 0, fingerprint: "", errors: mcpCur.errors };
  const fingerprint = removeFingerprint(pluginName, plan.lock.version, plan.steps, skillDests, mcpTargets, mcpCur.current);
  return { found: true, orphans: expectedCount - removedCount, removedCount, expectedCount, skillCount: skillDests.length, mcpCount: mcpTargets.length, fingerprint, errors: [] };
}

export interface RemoveResult {
  removed: boolean;
  orphans: number;
  errors: string[];
}

/** Remove a plugin across all its runtimes: un-merge exactly the recorded groups from each runtime's config
 *  (leaving user-edited groups as surfaced orphans), delete the payload, drop the lockfile entry. Fail-closed. */
export function applyRemove(pluginName: string, workspaceRoot: string, opts: { expectedFingerprint?: string } = {}): RemoveResult {
  const plan = planRemove(pluginName, workspaceRoot);
  if (plan.errors.length > 0) return { removed: false, orphans: 0, errors: plan.errors };
  if (!plan.lock || !plan.lockfile) return { removed: false, orphans: 0, errors: [`plugin '${pluginName}' is not installed`] };

  const skillDests = skillDestsOf(plan.lock);
  const mcpTargets = mcpTargetsOf(plan.lock);
  const mcpCur = currentMcpReps(workspaceRoot, mcpTargets);
  if (mcpCur.errors.length > 0) return { removed: false, orphans: 0, errors: mcpCur.errors };
  // consent binding (TOCTOU): refuse if the plugin changed (updated/reinstalled) OR a recorded MCP server
  // appeared/changed on disk since the remove was previewed.
  if (opts.expectedFingerprint !== undefined && removeFingerprint(pluginName, plan.lock.version, plan.steps, skillDests, mcpTargets, mcpCur.current) !== opts.expectedFingerprint) {
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
  const mcpByRuntime = new Map<Runtime, MaterializedTarget[]>();
  for (const t of mcpTargets) mcpByRuntime.set(t.runtime, [...(mcpByRuntime.get(t.runtime) ?? []), t]);
  for (const [rt, ts] of mcpByRuntime) {
    const mcpRel = ADAPTERS[rt].mcpRel;
    if (!mcpRel) continue;
    const file = path.join(workspaceRoot, mcpRel);
    const rd = readFile(file);
    let text: string | undefined = rd.missing ? undefined : rd.text;
    for (const t of ts) {
      if (mcpRepEquals(currentMcp(rt, text, t.ref as string), t.removal)) text = removeMcpServerText(rt, text, t.ref as string);
      else orphans += 1;
    }
    writeMcpConfig(file, text ?? "");
  }

  fs.rmSync(path.join(workspaceRoot, PAYLOAD_ROOT, pluginName), { recursive: true, force: true });
  delete plan.lockfile.plugins[pluginName];
  writeLockfile(workspaceRoot, plan.lockfile);

  return { removed: true, orphans, errors: [] };
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
  /** per-runtime conflicts (edited baseline and/or user-added collisions). */
  conflicts: UpdateConflict[];
  /** the install plan that would apply the new version (the merge with prior). Present when an update is possible. */
  install?: InstallPreview;
  errors: string[];
}

/** Compare major.minor.patch numerically (prerelease ignored for ordering). <0 if a<b, 0 if equal, >0 if a>b. */
function compareVersions(a: string, b: string): number {
  const part = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const pa = part(a);
  const pb = part(b);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Plan an update WITHOUT writing — a 3-way comparison: the lockfile records what was installed (baseline),
 * the on-disk config is what's there now (current), and the plugin dir is the new version. Two conflict
 * kinds (both refuse without force): a baseline group the user EDITED/removed (current ≠ baseline), and a
 * user-ADDED group that already equals a new-version group (installing would DUPLICATE it). A lower version
 * is flagged as a downgrade. Returns the conflicts + the install plan for the new version.
 */
export function previewUpdate(plugin: LoadedPlugin, workspaceRoot: string, present: ReadonlySet<Runtime>): UpdatePreview {
  const toVersion = plugin.manifest.version;
  const plan = planRemove(plugin.manifest.name, workspaceRoot); // prior owned + current settings per runtime
  if (plan.errors.length > 0) return { found: !!plan.lock, upToDate: false, isDowngrade: false, toVersion, conflicts: [], errors: plan.errors };
  if (!plan.lock) return { found: false, upToDate: false, isDowngrade: false, toVersion, conflicts: [], errors: [] };
  const fromVersion = plan.lock.version;
  if (fromVersion === toVersion) {
    return { found: true, upToDate: true, isDowngrade: false, fromVersion, toVersion, conflicts: [], errors: [] };
  }

  const install = previewInstall(plugin, workspaceRoot, present);
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

  return { found: true, upToDate: false, isDowngrade: compareVersions(toVersion, fromVersion) < 0, fromVersion, toVersion, conflicts, install, errors: install.errors };
}

export interface UpdateResult {
  updated: boolean;
  upToDate?: boolean;
  conflicts?: UpdateConflict[];
  errors: string[];
}

/**
 * Apply an update. Refuses (without `force`) when (a) the user edited the installed plugin's hooks or added a
 * group that the new version would duplicate, or (b) the new version is a downgrade — so an update never
 * silently clobbers, duplicates, or rolls back. With `force`, proceeds with the install of the new version
 * (edited groups are left as conservative orphans — Tachyon never deletes a group the user edited).
 */
export function applyUpdate(plugin: LoadedPlugin, workspaceRoot: string, present: ReadonlySet<Runtime>, opts: { force?: boolean; provenance?: InstallProvenance; expectedFingerprint?: string; skillDecisions?: Record<string, "keep" | "replace">; mcpDecisions?: Record<string, "keep" | "replace">; mcpConfirmed?: boolean } = {}): UpdateResult {
  const preview = previewUpdate(plugin, workspaceRoot, present);
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
  const res = applyInstall(plugin, preview.install, workspaceRoot, present, { provenance: opts.provenance, skillDecisions: opts.skillDecisions, mcpDecisions: opts.mcpDecisions, mcpConfirmed: opts.mcpConfirmed });
  return { updated: res.installed, conflicts: preview.conflicts, errors: res.errors };
}
