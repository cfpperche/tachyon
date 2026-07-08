/**
 * Isolated harness materialization (spec 226). Each opt-in agent gets a PRIVATE config home so its
 * MCP servers never leak to sibling agents. v1 = claude-only, mcp-only.
 *
 * Mechanism (verified live 2026-06-16, see docs/specs/226):
 *   - redirect the whole config home via `CLAUDE_CONFIG_DIR=<home>` (auth/settings/plugins/transcripts);
 *   - scope MCP with `--mcp-config <home>/mcp.json --strict-mcp-config` (ONLY that file's servers —
 *     ignores the project `.mcp.json` and global), so there is no sibling/project/global leak;
 *   - seed auth by SYMLINKING `.credentials.json` → the real home (a fresh home is unauthenticated;
 *     a symlink keeps an OAuth refresh valid where a copy would go stale);
 *   - secrets stay as `${VAR}` references in mcp.json (claude expands them from the process env at
 *     spawn) — never a literal secret on disk.
 *
 * Mirrors src/worktree/ and src/resume/: the PURE helpers (path/merge/wiring builders) live here as
 * standalone functions and unit-test with no fs; the side-effecting materialize/remove/list plug in
 * on top with real fs (covered by an integration test in a tmp dir).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessDef } from "../config/loadConfig.js";
import type { ResumeAdapter } from "../resume/adapters.js";
import {
  buildCodexSessionStartHookConfig,
  buildOwnershipSettings,
  continuityPointerPath,
  persistenceHookFailureFile,
  handoffPointerPath,
  persistenceStopFile,
  persistenceStopRecorderPath,
  sessionOwnerRecorderPath,
  sessionOwnersFile,
  spawnSettingsPath,
  PERSISTENCE_STOP_RECORDER_SOURCE,
  SESSION_CONTINUITY_POINTER_SOURCE,
  SESSION_HANDOFF_POINTER_SOURCE,
  SESSION_OWNER_RECORDER_SOURCE,
} from "../activity/sessionOwners.js";
import { renderCodexMcpBlock } from "../plugins/adapters/codex.js";
import { setCodexMcpServer, setOpencodeMcpServer, expectedAgentOpencodeEntry } from "../registration/adapters.js";

/** What a materialized harness contributes to the spawn: the config home, the env that redirects to
 *  it, and the MCP args. Threaded into the spawn/restart/resume/fork command (H3). */
export interface MaterializedHarness {
  /** absolute config home (the `CLAUDE_CONFIG_DIR`) — also where transcripts now live (H2). */
  home: string;
  /** env additions, merged into the agent's spawn env (e.g. `{ CLAUDE_CONFIG_DIR: home }`). */
  env: Record<string, string>;
  /** arg additions appended to the spawn command (e.g. `--mcp-config <path> --strict-mcp-config`). */
  args: string[];
}

/** Root holding every per-agent harness home for a workspace: `<workspaceRoot>/.tachyon/harness`. */
export function harnessRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "harness");
}

/** Crash-/race-safe file write: stage to a unique temp on the SAME dir, then atomic renameSync. A concurrent
 *  reader (e.g. a sibling agent's SessionStart hook running the materialized recorder) sees the old or new
 *  complete file, never a truncated one. Unique temp (pid + monotonic seq) — no Date.now (resume-safe idiom). */
let __atomicSeq = 0;
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${__atomicSeq++}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

let __removeSeq = 0;
const TRANSIENT_RM_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isErrnoCode(e: unknown, code: string): boolean {
  return (e as NodeJS.ErrnoException).code === code;
}

function removeRecursiveWithRetry(target: string, attempts = 3): void {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1 || !TRANSIENT_RM_CODES.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      sleepSync(25 * (i + 1));
    }
  }
}

function removeDirByRenameThenRm(target: string): void {
  const parent = path.dirname(target);
  const base = path.basename(target);
  let trash = "";
  for (let i = 0; i < 3; i++) {
    trash = path.join(parent, `.${base}.removing-${process.pid}-${__removeSeq++}`);
    try {
      fs.renameSync(target, trash);
      removeRecursiveWithRetry(trash);
      return;
    } catch (e) {
      if (isErrnoCode(e, "ENOENT")) return;
      if (isErrnoCode(e, "EEXIST")) continue;
      throw e;
    }
  }
  throw new Error(`could not allocate temporary removal path for ${target}`);
}

function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function tomlKey(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : tomlString(k);
}

function tomlValue(v: unknown): string {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{ ${Object.entries(v as Record<string, unknown>).map(([k, val]) => `${tomlKey(k)} = ${tomlValue(val)}`).join(", ")} }`;
  }
  return tomlString(String(v ?? ""));
}

function appendCodexHooksConfig(existing: string, hooks: Record<string, unknown>): string {
  let lines = existing.split("\n");
  for (const event of Object.keys(hooks)) {
    const dotted = new RegExp(`^\\s*hooks\\.${event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
    lines = lines.filter((line) => !dotted.test(line));
  }
  let toml = lines.join("\n").replace(/\n*$/, "");
  const block = Object.entries(hooks).map(([event, value]) => `hooks.${tomlKey(event)} = ${tomlValue(value)}`).join("\n");
  if (block.length === 0) return existing;
  return `${toml}${toml.length > 0 ? "\n\n" : ""}${block}\n`;
}

/** The per-agent config home. Agent names are already fs-safe (NAME_RE). */
export function harnessHome(workspaceRoot: string, agent: string): string {
  return path.join(harnessRoot(workspaceRoot), agent);
}

/** The materialized MCP config file claude is pointed at via `--mcp-config`. */
export function harnessMcpPath(workspaceRoot: string, agent: string): string {
  return path.join(harnessHome(workspaceRoot, agent), "mcp.json");
}

/** The materialized Codex config file under the redirected CODEX_HOME. */
export function harnessCodexConfigPath(workspaceRoot: string, agent: string): string {
  return path.join(harnessHome(workspaceRoot, agent), "config.toml");
}

/** Root for the per-agent Bridge-only `--mcp-config` files (spec 236 — non-harness claude injection). */
export function bridgeMcpRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "bridge-mcp");
}

/** The per-agent Bridge-only `--mcp-config` file appended (additively, no `--strict`) to a NON-harness
 *  claude agent so it reaches the Tachyon Bridge with zero workspace-file config (spec 236). */
export function bridgeMcpPath(workspaceRoot: string, agent: string): string {
  return path.join(bridgeMcpRoot(workspaceRoot), `${agent}.json`);
}

/** spec 236 — the per-agent Bridge-only opencode config file pointed at by the OPENCODE_CONFIG env var
 *  (additive over a project opencode.json passed as `existing`). Distinct filename from the claude file
 *  so an opencode and a claude agent that happen to share a name never overwrite each other's bridge
 *  file. */
export function bridgeOpencodeMcpPath(workspaceRoot: string, agent: string): string {
  return path.join(bridgeMcpRoot(workspaceRoot), `${agent}.opencode.json`);
}

/**
 * Merge the MCP servers claude will see. For `inherit: workspace` the workspace `.mcp.json` snapshot
 * is the base (COPIED at materialize time — `--strict-mcp-config` ignores the on-disk project file,
 * so it must be folded in here, H6); the agent's declared servers overlay it (declared wins on a name
 * collision). For `inherit: none` only the declared servers are returned.
 *
 * The Tachyon Bridge (`bridgeEntry`) is folded in LAST and always wins (its `tachyon_bridge` name is
 * reserved at validation): a harness agent is spawned with `--strict-mcp-config`, which ignores the
 * project `.mcp.json`/global, so the Bridge MUST live in this materialized file or the agent can't
 * reach `complete_node`/`write_input` (spec 236 — the `inherit: none` drop bug). Omitted when the
 * Bridge URL is absent at spawn (self-heals on the next (re)start once it's up).
 */
export function mergeServers(
  def: HarnessDef,
  workspaceServers: Record<string, unknown> | null,
  bridgeEntry?: Record<string, unknown>,
): Record<string, unknown> {
  const base = def.inherit === "workspace" && workspaceServers ? { ...workspaceServers } : {};
  const merged = { ...base, ...(def.mcp ?? {}) };
  if (bridgeEntry) merged.tachyon_bridge = bridgeEntry;
  return merged;
}

/** The `--mcp-config` file body: `{ mcpServers: {...} }` (claude's documented shape). */
export function buildMcpConfig(servers: Record<string, unknown>): { mcpServers: Record<string, unknown> } {
  return { mcpServers: servers };
}

/** The env+args a redirected home + scoped MCP contribute, from the adapter's pure harness shape. */
export function harnessWiring(adapter: ResumeAdapter, home: string, mcpPath: string): { env: Record<string, string>; args: string[] } {
  const h = adapter.harness;
  if (!h) return { env: {}, args: [] };
  return { env: { [h.configHomeEnv]: home }, args: h.mcp.mode === "flag" ? h.mcp.args(mcpPath) : [] };
}

/** Every `${VAR}` env name referenced across the harness MCP server `env` blocks (deduped). The real
 *  values must be injected into the spawned process env so claude can expand the literal `${VAR}` it
 *  reads from `mcp.json` (H7 — verified live: claude expands from the process env, not the file). */
export function collectEnvRefs(def: HarnessDef): string[] {
  const names = new Set<string>();
  for (const server of Object.values(def.mcp ?? {})) {
    for (const value of Object.values(server.env ?? {})) {
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      if (m) names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * spec 227 — parse a `.env` file into a flat map. Dependency-light (matches the hand-rolled YAML
 * validator): `KEY=value`, optional `export ` prefix, surrounding single/double quotes stripped, `#`
 * comment + blank lines ignored, malformed lines skipped. No `${OTHER}` interpolation (plain values).
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Raised when a harness can't be materialized (no auth, or a referenced secret isn't in the env). */
export class HarnessUnavailableError extends Error {
  constructor(readonly agent: string, reason: string) {
    super(`isolated harness for '${agent}': ${reason}`);
    this.name = "HarnessUnavailableError";
  }
}

/** Read a workspace `.mcp.json`'s `mcpServers` map, or null if absent/unreadable/malformed. */
export function readWorkspaceMcpServers(workspaceRoot: string): Record<string, unknown> | null {
  const p = path.join(workspaceRoot, ".mcp.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The real (authenticated) config home Tachyon's own process uses — the symlink target for auth. */
export function realConfigHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override && override.length > 0 ? override : path.join(homeDir, ".claude");
}

/** The real Codex config home Tachyon's process uses. */
export function defaultRealCodexHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env.CODEX_HOME?.trim();
  return override && override.length > 0 ? override : path.join(homeDir, ".codex");
}

/** spec t-e2ebe3 — the real (authenticated) XDG_DATA_HOME for opencode (auth lives at
 *  `<xdg>/opencode/auth.json`, mode 600). Honors the `XDG_DATA_HOME` override; defaults to
 *  `~/.local/share` (the XDG spec default). Returns the bare XDG root (NOT `…/opencode`) so
 *  callers can `path.join` it with the authFiles path (`opencode/auth.json`). */
export function defaultRealOpencodeDataHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env.XDG_DATA_HOME?.trim();
  return override && override.length > 0 ? override : path.join(homeDir, ".local", "share");
}

/** spec t-e2ebe3 — the opencode harness home layout: a private XDG triple (config/data/state) under the
 *  harness home. Used by HarnessManager (materialize) and the resume/resolver paths (transcript lookup
 *  keys off the data dir, where opencode stores `opencode/storage`). */
export function opencodeHarnessDirs(home: string): { config: string; data: string; state: string } {
  return { config: path.join(home, "config"), data: path.join(home, "data"), state: path.join(home, "state") };
}

/**
 * spec 228 dogfood fix — the real `.claude.json` (claude's main config). NOTE: by default it lives at
 * `$HOME/.claude.json` (home), NOT under `~/.claude`; with CLAUDE_CONFIG_DIR set it's `<dir>/.claude.json`.
 */
export function realClaudeJsonPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override && override.length > 0 ? path.join(override, ".claude.json") : path.join(homeDir, ".claude.json");
}

/**
 * Onboarding/account markers copied from the real `.claude.json` into the harness home's `.claude.json`
 * so the INTERACTIVE TUI doesn't re-run the first-run onboarding/login wizard in a fresh config home
 * (dogfood: a redirected home authenticates via the token in `-p`, but interactive claude gates the
 * wizard on `hasCompletedOnboarding`, which a fresh home lacks). These are the user's own non-secret
 * account markers (the secret token stays in the symlinked `.credentials.json`).
 */
const ONBOARDING_SEED_KEYS = ["hasCompletedOnboarding", "lastOnboardingVersion", "hasIdeOnboardingBeenShown", "userID", "oauthAccount", "firstStartTime"];

export class HarnessManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly realHome: string = realConfigHome(),
    /** Source for resolving `${VAR}` secret refs into the spawned env (default the host process env). */
    private readonly procEnv: NodeJS.ProcessEnv = process.env,
    /** The real `.claude.json` to seed onboarding/account markers from (default its true location). */
    private readonly realClaudeJson: string = realClaudeJsonPath(procEnv),
    /** Source Codex home for auth/config seeding. */
    private readonly realCodexHome: string = defaultRealCodexHome(procEnv),
    /** Sink for non-fatal warnings (e.g. a malformed project file degrading a materialize step). */
    private readonly warn?: (message: string) => void,
    /** spec t-e2ebe3 — real XDG_DATA_HOME root for opencode auth seeding (default `~/.local/share`). */
    private readonly realOpencodeDataHome: string = defaultRealOpencodeDataHome(procEnv),
  ) {}

  home(agent: string): string {
    return harnessHome(this.workspaceRoot, agent);
  }

  /** spec 227 — the project `.env` (gitignored), parsed; `{}` if absent/unreadable. A secondary
   *  source for `${VAR}` secrets so the common case needs no shell export (process.env still wins). */
  private readEnvFile(): Record<string, string> {
    try {
      return parseEnvFile(fs.readFileSync(path.join(this.workspaceRoot, ".env"), "utf8"));
    } catch {
      return {};
    }
  }

  /**
   * Build (or rebuild) the agent's config home and return its spawn wiring. Idempotent —
   * rematerialize on every spawn/restart/resume so config edits propagate (H6). Throws if the
   * adapter has no harness support (a non-harnessable runtime should never reach here — validation
   * already rejects `harness:` on it, H9).
   */
  materialize(agent: string, def: HarnessDef, adapter: ResumeAdapter, cwd?: string, bridgeEntry?: Record<string, unknown>): MaterializedHarness {
    const h = adapter.harness;
    if (!h) throw new Error(`runtime '${adapter.runtime}' does not support an isolated harness`);

    // H7 — resolve the ${VAR} secret refs BEFORE any fs side effect, and fail closed if one is missing:
    // claude expands ${VAR} from the spawned PROCESS env (not the mcp.json file), so the real value must
    // be injected there. spec 227 — source = the ambient process env OR a project `.env` (gitignored),
    // process.env taking precedence (dotenv semantics) so the common case needs no shell export.
    const envFile = this.readEnvFile();
    const secretEnv: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of collectEnvRefs(def)) {
      const v = this.procEnv[name] ?? envFile[name];
      if (v === undefined || v === "") missing.push(name);
      else secretEnv[name] = v;
    }
    if (missing.length > 0) {
      throw new HarnessUnavailableError(agent, `set these env var(s) before starting it: ${missing.join(", ")} — in the project .env or your shell (referenced by an MCP server)`);
    }

    // spec t-e2ebe3 — opencode's Bridge entry is opencode-shaped (`type:remote`, `{env:VAR}` token ref). The
    // caller (Workspace) passes the SHARED bridgeEntry (claude-shaped) for all runtimes; normalize here so the
    // materialized opencode.json carries the right shape without the caller needing a runtime-aware entry.
    let bridge = bridgeEntry;
    if (adapter.runtime === "opencode" && bridge) {
      const url = typeof bridge.url === "string" ? bridge.url : "";
      const auth = !!(bridge.headers && typeof bridge.headers === "object" && (bridge.headers as Record<string, unknown>).Authorization);
      bridge = url ? expectedAgentOpencodeEntry(url, auth) : undefined;
    }

    const home = this.materializeHome(agent, adapter, cwd); // private home + auth symlink/onboarding markers

    // mcp — ALWAYS scope a harness agent. Claude gets a strict `mcp.json` + flags; Codex gets a private
    // `config.toml` under CODEX_HOME; opencode (XDG) gets `opencode/opencode.json` under XDG_CONFIG_HOME.
    // In all cases inherit:none excludes workspace MCP; inherit:workspace snapshots the workspace runtime
    // config into the private home. H7: ${VAR} stays literal on disk.
    const workspaceServers = def.inherit === "workspace" ? readWorkspaceMcpServers(this.workspaceRoot) : null;
    const mergedServers = mergeServers(def, workspaceServers, bridge);
    const args = this.materializeMcpConfig(agent, def, adapter, home, mergedServers, bridge);
    if (adapter.runtime === "codex") {
      this.materializeCodexInstructions(agent, def, home);
      this.materializeSkills(agent, def, home);
      return { home, env: { [h.configHomeEnv]: home, ...secretEnv }, args };
    }

    if (h.xdg) {
      // spec t-e2ebe3 — opencode harness: home stays `.tachyon/harness/<agent>`; the three XDG env vars
      // point at its `config/data/state` subdirs. No args (the harness has no `--mcp-config`/`-c`; the
      // Bridge MCP is folded into `<config>/opencode/opencode.json`, auto-discovered by opencode).
      const dirs = opencodeHarnessDirs(home);
      this.materializeSkills(agent, def, home); // spec 228 — Tachyon-owned, rebuilt clean (no leak on remove)
      return {
        home,
        env: {
          [h.configHomeEnv]: dirs.config,
          [h.xdg.dataEnv]: dirs.data,
          [h.xdg.stateEnv]: dirs.state,
          ...secretEnv,
        },
        args,
      };
    }

    // spec 228 — rules → <home>/CLAUDE.md. Tachyon-OWNED (M3): written when declared, REMOVED when not,
    // so a rule the user deleted from the config doesn't linger in a reused home. Paths must stay under
    // the workspace (M4). Fail closed on a missing file.
    const claudeMd = path.join(home, "CLAUDE.md");
    if (def.rules && def.rules.length > 0) {
      const sections = def.rules.map((rel) => {
        const abs = this.resolveInWorkspace(agent, rel, "rules file");
        let body: string;
        try {
          body = fs.readFileSync(abs, "utf8");
        } catch {
          throw new HarnessUnavailableError(agent, `rules file not found: ${rel}`);
        }
        return `# === ${rel} ===\n${body.trimEnd()}\n`;
      });
      fs.writeFileSync(claudeMd, sections.join("\n"));
    } else {
      fs.rmSync(claudeMd, { force: true });
    }

    // spec 228 — skills → <home>/skills/<basename>/ (resolves via /<name>). Tachyon-OWNED (M3): the dir
    // is rebuilt clean EVERY materialize (even when none declared), so a removed skill disappears. Each
    // source must be a dir with SKILL.md, under the workspace (M4), with a unique basename.
    this.materializeSkills(agent, def, home);

    // spec 228 — hooks → <home>/settings.json `hooks` key (claude reads it; verified fires). Tachyon-OWNED
    // (M3): SET when declared, DELETED when not — preserving any OTHER settings keys — so a removed hook
    // stops firing. Drop the file if it ends up empty.
    const settingsPath = path.join(home, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      /* no settings yet */
    }
    if (def.hooks) settings.hooks = def.hooks;
    else delete settings.hooks;
    if (Object.keys(settings).length > 0) fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    else fs.rmSync(settingsPath, { force: true });

    // CLAUDE_CONFIG_DIR (always) + the strict-mcp args (always, for a harness) + the resolved secrets (H7).
    return { home, env: { [h.configHomeEnv]: home, ...secretEnv }, args };
  }

  private materializeSkills(agent: string, def: HarnessDef, home: string): void {
    const skillsRoot = path.join(home, "skills");
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    if (!def.skills || def.skills.length === 0) return;
    fs.mkdirSync(skillsRoot, { recursive: true });
    const seen = new Set<string>();
    for (const rel of def.skills) {
      const src = this.resolveInWorkspace(agent, rel, "skill dir");
      if (!fs.existsSync(path.join(src, "SKILL.md"))) throw new HarnessUnavailableError(agent, `skill dir must contain a SKILL.md: ${rel}`);
      const base = path.basename(src);
      if (seen.has(base)) throw new HarnessUnavailableError(agent, `duplicate skill name '${base}' (${rel})`);
      seen.add(base);
      fs.cpSync(src, path.join(skillsRoot, base), { recursive: true });
    }
  }

  private materializeCodexInstructions(agent: string, def: HarnessDef, home: string): void {
    const agentsMd = path.join(home, "AGENTS.md");
    if (!def.instructions || def.instructions.length === 0) {
      fs.rmSync(agentsMd, { force: true });
      return;
    }
    const sections = def.instructions.map((rel) => {
      const abs = this.resolveInWorkspace(agent, rel, "instructions file");
      let body: string;
      try {
        body = fs.readFileSync(abs, "utf8");
      } catch {
        throw new HarnessUnavailableError(agent, `instructions file not found: ${rel}`);
      }
      return `# === ${rel} ===\n${body.trimEnd()}\n`;
    });
    fs.writeFileSync(agentsMd, sections.join("\n"));
  }

  /**
   * spec 240 — seed ONLY the private config home (mkdir + auth symlink + onboarding/trust markers), shared by
   * the full `harness:` path and the lightweight `isolate: transcript` mode. Throws (logged-out) when the real
   * home has no credentials. Returns the home path. Identical home/auth/onboarding behavior to the harness.
   */
  materializeHome(agent: string, adapter: ResumeAdapter, cwd?: string): string {
    const h = adapter.harness;
    if (!h) throw new Error(`runtime '${adapter.runtime}' does not support an isolated config home`);
    const home = this.home(agent);
    fs.mkdirSync(home, { recursive: true });

    if (h.xdg) {
      // spec t-e2ebe3 — opencode XDG layout: three subdirs under the home + auth COPY (mode 600) under the
      // data subdir. COPY (not symlink): opencode refreshes its token in place and a shared symlink would
      // race the real home on multi-agent runs. Fail closed when the real auth is absent — else an empty
      // XDG_DATA_HOME is the FOOTGUN: the agent DEGRADES SILENTLY to a fallback model (not the signed one)
      // with NO error, so missing-auth must hard-fail (not just warn).
      const dirs = opencodeHarnessDirs(home);
      fs.mkdirSync(dirs.config, { recursive: true });
      fs.mkdirSync(dirs.data, { recursive: true });
      fs.mkdirSync(dirs.state, { recursive: true });
      for (const authFile of h.authFiles) {
        const authLink = path.join(dirs.data, authFile); // relative to XDG_DATA_HOME
        const authTarget = path.join(this.realOpencodeDataHome, authFile); // real source (~/.local/share/<authFile>)
        if (!fs.existsSync(authTarget)) {
          throw new HarnessUnavailableError(
            agent,
            `no credentials at ${authTarget} — run 'opencode auth login' first (a redirected XDG_DATA_HOME starts unauthenticated → opencode silently degrades to a fallback model with no error)`,
          );
        }
        fs.mkdirSync(path.dirname(authLink), { recursive: true });
        try {
          fs.unlinkSync(authLink);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        fs.copyFileSync(authTarget, authLink);
        fs.chmodSync(authLink, 0o600); // the secret is a real auth.json — mode 600, never group/world readable
      }
      return home;
    }

    // H1 — seed auth by symlinking the credential file to the real home (never a copy → no stale token).
    // Fail closed if the real credential is absent (claude not logged in) — else a fresh home spawns
    // unauthenticated (codex impl-review M3): a dangling symlink "succeeds" but the agent can't start.
    const authSourceHome = adapter.runtime === "codex" ? this.realCodexHome : this.realHome;
    for (const authFile of h.authFiles) {
      const authLink = path.join(home, authFile);
      const authTarget = path.join(authSourceHome, authFile);
      if (!fs.existsSync(authTarget)) {
        const login = adapter.runtime === "codex" ? "codex login" : "claude /login";
        throw new HarnessUnavailableError(agent, `no credentials at ${authTarget} — run ${login} first (a redirected config home starts logged out)`);
      }
      // unlinkSync (NOT rmSync) — it removes the symlink ITSELF without following it; rmSync({force})
      // follows a broken link, hits ENOENT on the missing target, silently no-ops, and leaves the stale
      // link → EEXIST on re-symlink. Ignore ENOENT (nothing to remove on first materialize).
      try {
        fs.unlinkSync(authLink);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      fs.symlinkSync(authTarget, authLink);
    }

    if (adapter.runtime === "codex") {
      return home;
    }

    // dogfood fix — seed the onboarding/account markers into <home>/.claude.json so the INTERACTIVE TUI
    // skips the first-run login/onboarding wizard. A redirected config home authenticates via the token
    // (symlinked .credentials.json) in -p, but interactive claude gates the wizard on
    // `hasCompletedOnboarding`, which a fresh home lacks → it showed "Select login method" despite a
    // valid token. Merge the allowlisted markers (the user's own non-secret account fields) + force the
    // flag, preserving any other keys claude has written. Best-effort: absent real config → leave it.
    try {
      const realCfg = JSON.parse(fs.readFileSync(this.realClaudeJson, "utf8")) as Record<string, unknown>;
      const claudeJsonPath = path.join(home, ".claude.json");
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8")) as Record<string, unknown>;
      } catch {
        /* none yet — claude will bootstrap the rest on first run */
      }
      for (const k of ONBOARDING_SEED_KEYS) if (k in realCfg) cfg[k] = realCfg[k];
      cfg.hasCompletedOnboarding = true;
      // also pre-trust the agent's cwd so the per-folder "trust this folder?" prompt doesn't block the spawn.
      if (cwd) {
        const projects = (cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {}) as Record<string, Record<string, unknown>>;
        projects[cwd] = { ...(projects[cwd] ?? {}), hasTrustDialogAccepted: true };
        cfg.projects = projects;
      }
      fs.writeFileSync(claudeJsonPath, `${JSON.stringify(cfg, null, 2)}\n`);
    } catch {
      /* no real .claude.json to seed from — interactive may prompt; -p still authenticates via the token */
    }
    return home;
  }

  /**
   * spec 240 — `isolate: transcript`: a private config home (own transcript namespace) WITHOUT the harness
   * MCP/skills/rules/hooks. The agent still loads the workspace project config (CLAUDE.md/.claude/.mcp.json,
   * cwd-relative) and inherits auth (the symlinked credentials). No strict-MCP args.
   */
  materializeHomeOnly(agent: string, adapter: ResumeAdapter, cwd?: string): MaterializedHarness {
    const home = this.materializeHome(agent, adapter, cwd);
    const h = adapter.harness;
    if (!h) throw new Error(`runtime '${adapter.runtime}' does not support an isolated config home`);
    if (adapter.runtime === "codex") this.seedCodexHomeOnlyConfig(home);
    return { home, env: { [h.configHomeEnv]: home }, args: [] };
  }

  private materializeMcpConfig(_agent: string, def: HarnessDef, adapter: ResumeAdapter, home: string, servers: Record<string, unknown>, bridgeEntry?: Record<string, unknown>): string[] {
    const h = adapter.harness;
    if (!h) return [];
    if (h.mcp.mode === "flag") {
      const mcpPath = path.join(home, h.mcp.fileName);
      fs.writeFileSync(mcpPath, `${JSON.stringify(buildMcpConfig(servers), null, 2)}\n`);
      return h.mcp.args(mcpPath);
    }
    // home-config mode — codex writes `<CODEX_HOME>/config.toml` (path relative to the home); spec t-e2ebe3
    // opencode writes `opencode/opencode.json` relative to its XDG_CONFIG_HOME (= `<home>/config`), so the
    // file ends up at `<home>/config/opencode/opencode.json` (auto-discovered by opencode under XDG_CONFIG_HOME).
    const configRoot = h.xdg ? path.join(home, h.xdg.configRel) : home;
    const configPath = path.join(configRoot, h.mcp.fileName);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, adapter.runtime === "opencode" ? this.buildOpencodeHarnessConfig(def, bridgeEntry) : this.buildCodexHarnessConfig(def, bridgeEntry), "utf8");
    return [];
  }

  /** spec t-e2ebe3 — the opencode harness config body for `<XDG_CONFIG_HOME>/opencode/opencode.json`. Folds
   *  the Bridge MCP entry (opencode-shaped, `tachyon_bridge` reserved name) and any declared stdio servers
   *  (converted to opencode's `local` MCP shape) over the project `opencode.json` (inherit:workspace) or a
   *  fresh object. `${VAR}` env refs stay literal on disk (the real values are injected into the spawn env). */
  private buildOpencodeHarnessConfig(def: HarnessDef, bridgeEntry?: Record<string, unknown>): string {
    let content: string | undefined;
    if (def.inherit === "workspace") {
      try {
        content = fs.readFileSync(path.join(this.workspaceRoot, "opencode.json"), "utf8");
      } catch {
        content = undefined;
      }
    }
    for (const [name, server] of Object.entries(def.mcp ?? {})) {
      content = setOpencodeMcpServer(content, name, {
        type: "local",
        enabled: true,
        command: [server.command, ...(server.args ?? [])],
        ...(server.env ? { env: server.env } : {}),
      });
    }
    if (bridgeEntry) content = setOpencodeMcpServer(content, "tachyon_bridge", bridgeEntry);
    // setOpencodeMcpServer always sets $schema; if neither inherit nor servers nor bridge produced content,
    // emit a fresh `{ $schema, mcp: {} }` root so the file is a valid (empty) opencode config the runtime
    // can still auto-discover under XDG_CONFIG_HOME (the harness has no Bridge to fold when the Bridge is
    // down — self-heals on the next (re)spawn once it's up).
    return content ?? '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {}\n}\n';
  }

  private buildCodexHarnessConfig(def: HarnessDef, bridgeEntry?: Record<string, unknown>): string {
    let toml = "";
    if (def.inherit === "workspace") {
      try {
        toml = fs.readFileSync(path.join(this.workspaceRoot, ".codex", "config.toml"), "utf8");
      } catch {
        toml = "";
      }
    }
    for (const [name, server] of Object.entries(def.mcp ?? {})) {
      toml = setCodexMcpServer(toml, name, renderCodexMcpBlock({ name, transport: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? {} }));
    }
    if (bridgeEntry) {
      const url = typeof bridgeEntry.url === "string" ? bridgeEntry.url : "";
      const headers = bridgeEntry.headers && typeof bridgeEntry.headers === "object" && !Array.isArray(bridgeEntry.headers) ? (bridgeEntry.headers as Record<string, string>) : {};
      if (url) toml = setCodexMcpServer(toml, "tachyon_bridge", renderCodexMcpBlock({ name: "tachyon_bridge", transport: "http", url, headers }));
    }
    if (def.hooks) toml = appendCodexHooksConfig(toml, def.hooks);
    return toml.endsWith("\n") || toml.length === 0 ? toml : `${toml}\n`;
  }

  private seedCodexHomeOnlyConfig(home: string): void {
    const target = path.join(home, "config.toml");
    try {
      fs.copyFileSync(path.join(this.realCodexHome, "config.toml"), target);
    } catch {
      fs.rmSync(target, { force: true });
    }
    const authLink = path.join(home, "auth.json");
    const authTarget = path.join(this.realCodexHome, "auth.json");
    try {
      fs.unlinkSync(authLink);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    fs.symlinkSync(authTarget, authLink);
  }

  /**
   * spec 228 (codex M4) — resolve a harness path UNDER the workspace; reject an absolute path or one
   * whose real path escapes the workspace (traversal / a symlink pointing outside). A committed
   * tachyon.yml must not be able to read `/etc/passwd` or `../../secret` into the agent's private home.
   */
  private resolveInWorkspace(agent: string, rel: string, label: string): string {
    if (path.isAbsolute(rel)) throw new HarnessUnavailableError(agent, `${label} must be a workspace-relative path: ${rel}`);
    const abs = path.resolve(this.workspaceRoot, rel);
    let root: string;
    try {
      root = fs.realpathSync(this.workspaceRoot);
    } catch {
      root = path.resolve(this.workspaceRoot);
    }
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return abs; // doesn't exist yet — the caller's existence check reports it
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new HarnessUnavailableError(agent, `${label} escapes the workspace: ${rel}`);
    }
    return abs;
  }

  /** Remove the agent's config home (GC — caller gates on ledger state, H8). */
  remove(agent: string): void {
    removeDirByRenameThenRm(this.home(agent));
    this.removeBridgeMcp(agent);
  }

  /**
   * spec 236 — write the per-agent Bridge-only `--mcp-config` file for a NON-harness claude agent and
   * return its path. The Bearer token stays a literal `${TACHYON_BRIDGE_TOKEN}` ref (claude expands it
   * from the spawned process env), so no secret lands on disk or argv. Rewritten on every (re)spawn.
   */
  materializeBridgeMcp(agent: string, bridgeEntry: Record<string, unknown>): string {
    const file = bridgeMcpPath(this.workspaceRoot, agent);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(buildMcpConfig({ tachyon_bridge: bridgeEntry }), null, 2)}\n`);
    return file;
  }

  /**
   * spec 236 — write the per-agent Bridge-only opencode config file for a NON-harness opencode agent
   * and return its path. The caller injects that path into the agent's spawn env as OPENCODE_CONFIG so
   * opencode loads it (verified 1.17.15) instead of the project-discovered `opencode.json`. The Bearer
   * token stays a literal `{env:TACHYON_AGENT_BRIDGE_TOKEN}` ref — opencode resolves `{env:VAR}` at
   * runtime, so the per-agent token minted into the session env resolves to a strong identity with no
   * secret on disk. When `projectOpencodeJson` is supplied (the agent's cwd's existing opencode.json),
   * it is folded in so the user's other keys/servers ride alongside (additive); `mcp.tachyon_bridge`
   * always wins (collision-safe reserved name). Rewritten on every (re)spawn.
   *
   * The fold-in is best-effort: a malformed project `opencode.json` (bad JSON syntax, or valid JSON of
   * the wrong shape) must not block the spawn — this is the only harness/spawn path that parses a
   * user-editable file on every (re)spawn, and everyday edits (trailing commas, partial writes) are a
   * realistic trigger. On a parse failure, degrade to a Bridge-only file (skip the fold-in) and warn,
   * rather than let `JSON.parse`'s raw SyntaxError propagate uncaught through the spawn.
   */
  materializeBridgeMcpOpencode(agent: string, bridgeEntry: Record<string, unknown>, projectOpencodeJson?: string): string {
    const file = bridgeOpencodeMcpPath(this.workspaceRoot, agent);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let content: string;
    try {
      content = setOpencodeMcpServer(projectOpencodeJson, "tachyon_bridge", bridgeEntry);
    } catch (err) {
      if (projectOpencodeJson === undefined) throw err; // not a fold-in failure — a real bug, don't mask it
      this.warn?.(
        `'${agent}': project opencode.json is malformed — spawning with a Bridge-only config (skipping the fold-in): ${err instanceof Error ? err.message : String(err)}`,
      );
      content = setOpencodeMcpServer(undefined, "tachyon_bridge", bridgeEntry);
    }
    fs.writeFileSync(file, content, "utf8");
    return file;
  }

  /** Remove the agent's Bridge-only `--mcp-config` file (GC, best-effort). */
  removeBridgeMcp(agent: string): void {
    fs.rmSync(bridgeMcpPath(this.workspaceRoot, agent), { force: true });
  }

  /**
   * spec 243 — write the per-spawn `--settings` file whose `SessionStart` hook records session ownership,
   * and (idempotently) the standalone recorder it invokes. Returns the settings-file path to append via
   * `--settings`. Works for ANY claude agent (harness or not) and never mutates `~/.claude` or the repo's
   * `.claude/` — `--settings` is an additive command-line layer, so the agent's other hooks still run.
   * Rewritten on every (re)spawn (cheap; keeps the baked-in agent id + paths fresh after a rename/move).
   */
  materializeOwnershipSettings(agent: string, handoffPath?: string, opts: { silentPersistence?: boolean; skipDangerousModePermissionPrompt?: boolean } = {}): string {
    const recorder = sessionOwnerRecorderPath(this.workspaceRoot);
    fs.mkdirSync(path.dirname(recorder), { recursive: true });
    // Atomic write (temp + rename): concurrent (re)spawns rewrite the SHARED recorder, and a sibling's
    // SessionStart hook may be running `node <recorder>` at that instant — an in-place writeFileSync could
    // truncate it mid-read and silently drop the ownership row (codex review). renameSync is atomic on the
    // same fs, so a reader sees either the old or new complete file, never a torn one.
    atomicWrite(recorder, SESSION_OWNER_RECORDER_SOURCE);
    // spec 245 — when a handoff path is given, also materialize the SessionStart pointer script + add its command
    // (a one-line additionalContext pointer to the project handoff; never the content).
    let pointer: { pointerPath: string; handoffPath: string } | undefined;
    if (handoffPath) {
      const pointerPath = handoffPointerPath(this.workspaceRoot);
      atomicWrite(pointerPath, SESSION_HANDOFF_POINTER_SOURCE);
      pointer = { pointerPath, handoffPath };
    }
    let persistence: { continuityPointerPath: string; continuityPath: string; stopRecorderPath: string; stopFile: string; failureFile: string } | undefined;
    if (opts.silentPersistence) {
      const continuityPointer = continuityPointerPath(this.workspaceRoot);
      const stopRecorder = persistenceStopRecorderPath(this.workspaceRoot);
      atomicWrite(continuityPointer, SESSION_CONTINUITY_POINTER_SOURCE);
      atomicWrite(stopRecorder, PERSISTENCE_STOP_RECORDER_SOURCE);
      persistence = {
        continuityPointerPath: continuityPointer,
        continuityPath: path.join(this.workspaceRoot, ".tachyon", "continuity", `${agent}.md`),
        stopRecorderPath: stopRecorder,
        stopFile: persistenceStopFile(this.workspaceRoot),
        failureFile: persistenceHookFailureFile(this.workspaceRoot),
      };
    }
    const settings = buildOwnershipSettings(recorder, agent, sessionOwnersFile(this.workspaceRoot), pointer, persistence, {
      skipDangerousModePermissionPrompt: opts.skipDangerousModePermissionPrompt,
    });
    const file = spawnSettingsPath(this.workspaceRoot, agent);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`); // same race for the per-agent settings on restart/resume
    return file;
  }

  /**
   * spec 303 — Codex has native lifecycle hooks, but no Claude-style `--settings` file layer. Inject
   * session-scoped `-c key=value` overrides instead; Codex merges them with workspace/user hooks.
   */
  materializeCodexSessionStartHookConfig(agent: string, handoffPath?: string, opts: { silentPersistence?: boolean } = {}): string | string[] {
    const recorder = sessionOwnerRecorderPath(this.workspaceRoot);
    fs.mkdirSync(path.dirname(recorder), { recursive: true });
    atomicWrite(recorder, SESSION_OWNER_RECORDER_SOURCE);
    let pointer: { pointerPath: string; handoffPath: string } | undefined;
    if (handoffPath) {
      const pointerPath = handoffPointerPath(this.workspaceRoot);
      atomicWrite(pointerPath, SESSION_HANDOFF_POINTER_SOURCE);
      pointer = { pointerPath, handoffPath };
    }
    let persistence: { continuityPointerPath: string; continuityPath: string; stopRecorderPath: string; stopFile: string; failureFile: string } | undefined;
    if (opts.silentPersistence) {
      const continuityPointer = continuityPointerPath(this.workspaceRoot);
      const stopRecorder = persistenceStopRecorderPath(this.workspaceRoot);
      atomicWrite(continuityPointer, SESSION_CONTINUITY_POINTER_SOURCE);
      atomicWrite(stopRecorder, PERSISTENCE_STOP_RECORDER_SOURCE);
      persistence = {
        continuityPointerPath: continuityPointer,
        continuityPath: path.join(this.workspaceRoot, ".tachyon", "continuity", `${agent}.md`),
        stopRecorderPath: stopRecorder,
        stopFile: persistenceStopFile(this.workspaceRoot),
        failureFile: persistenceHookFailureFile(this.workspaceRoot),
      };
    }
    return buildCodexSessionStartHookConfig(recorder, sessionOwnersFile(this.workspaceRoot), pointer, persistence);
  }

  /** Agent names with a materialized Bridge `--mcp-config` file (`<name>.json`), for the GC sweep. */
  listBridgeMcp(): string[] {
    try {
      return fs.readdirSync(bridgeMcpRoot(this.workspaceRoot), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  /** Existing per-agent harness home names (for the ownerless-dir GC sweep, H8). */
  list(): string[] {
    try {
      return fs.readdirSync(harnessRoot(this.workspaceRoot), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
}
