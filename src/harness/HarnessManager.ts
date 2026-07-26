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

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { HarnessDef } from "../config/loadConfig.js";
import type { ResolvedAgentNativeConfigProjection } from "../config/agentNativeConfigPolicy.js";
import type { ResolvedAgentCapabilityProjection } from "../config/agentProfileResolver.js";
import type { CapturedCapabilitySource } from "../config/agentCapabilitySource.js";
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
import { materializePiAgentHome, materializePiSessionDir, PI_AGENT_DIR_ENV, PI_SESSION_DIR_ENV } from "../agents/piSession.js";

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
function atomicWrite(file: string, content: string, mode?: number): void {
  const tmp = `${file}.tmp-${process.pid}-${__atomicSeq++}`;
  fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
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

function isReadableRegularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(file).length >= 0;
  } catch {
    return false;
  }
}

function isReadableJsonObjectFile(file: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function isReadableNoFollowJsonObjectFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && isReadableJsonObjectFile(file);
  } catch {
    return false;
  }
}

/** Rank fields for comparing Grok/Hermes auth.json candidates (t-2b0a08 / t-6c8437). */
export interface AuthCredentialRank {
  mtimeMs: number;
  createTimeMs: number;
  /** Latest `expires_at` across entries; 0 if none. */
  expiresAtMs: number;
  /**
   * Access token still within `expires_at` (or no expiry field → treat as valid).
   * Expired host auth must lose to a non-expired private refresh even when mtimes confuse us.
   */
  accessValid: boolean;
}

/**
 * Grok (and Hermes) write `auth.json` via create+rename under a redirected home, which **replaces**
 * a symlink with a regular file. OIDC refresh tokens are typically single-use / rotate: each private
 * home can end up with a *different* live key, and only the newest is valid server-side.
 * Ranking: non-expired access preferred, then OIDC `create_time`, then mtime (t-6c8437).
 */
export function authCredentialRank(file: string, nowMs: number = Date.now()): AuthCredentialRank {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return { mtimeMs: 0, createTimeMs: 0, expiresAtMs: 0, accessValid: false };
  }
  let createTimeMs = 0;
  let expiresAtMs = 0;
  let sawExpires = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const ct = (value as { create_time?: unknown }).create_time;
        if (typeof ct === "string") {
          const ms = Date.parse(ct);
          if (Number.isFinite(ms) && ms > createTimeMs) createTimeMs = ms;
        }
        const exp = (value as { expires_at?: unknown }).expires_at;
        if (typeof exp === "string") {
          const ms = Date.parse(exp);
          if (Number.isFinite(ms)) {
            sawExpires = true;
            if (ms > expiresAtMs) expiresAtMs = ms;
          }
        }
      }
    }
  } catch {
    /* rank by mtime only */
  }
  // No expires_at (legacy test fixtures) → do not punish; OIDC entries with past expiry lose.
  const accessValid = !sawExpires || expiresAtMs > nowMs;
  return { mtimeMs, createTimeMs, expiresAtMs, accessValid };
}

export function authRankBetter(a: AuthCredentialRank, b: AuthCredentialRank): boolean {
  if (a.accessValid !== b.accessValid) return a.accessValid;
  if (a.createTimeMs !== b.createTimeMs) return a.createTimeMs > b.createTimeMs;
  return a.mtimeMs > b.mtimeMs;
}

/**
 * True when any workspace private Grok home has replaced the auth symlink with a regular file
 * (OIDC refresh in-session). Cheap signal to run harvest without waiting for stop/kill (t-6c8437).
 */
export function privateGrokAuthNeedsHarvest(workspaceRoot: string): boolean {
  for (const home of listWorkspaceGrokPrivateHomes(workspaceRoot)) {
    try {
      const st = fs.lstatSync(path.join(home, "auth.json"));
      if (st.isFile() && !st.isSymbolicLink()) return true;
    } catch {
      /* missing — skip */
    }
  }
  return false;
}

/**
 * If `privateAuth` is a regular file newer/fresher than `realAuth`, copy it onto the real path
 * (mode 600). No-op for missing/symlink/unreadable private files. Used by rematerialize and by
 * workspace-wide reconcile so stop/resume does not strand fresh tokens in a per-agent home.
 */
export function promoteNewerPrivateAuth(privateAuth: string, realAuth: string): boolean {
  let privateStat: fs.Stats;
  try {
    privateStat = fs.lstatSync(privateAuth);
  } catch (e) {
    if (isErrnoCode(e, "ENOENT")) return false;
    throw e;
  }
  if (!privateStat.isFile() || privateStat.isSymbolicLink()) return false;
  if (!isReadableJsonObjectFile(privateAuth)) return false;

  let realExists = false;
  try {
    fs.statSync(realAuth);
    realExists = true;
  } catch (e) {
    if (!isErrnoCode(e, "ENOENT")) throw e;
  }

  if (realExists) {
    const privateRank = authCredentialRank(privateAuth);
    const realRank = authCredentialRank(realAuth);
    if (!authRankBetter(privateRank, realRank)) return false;
  }

  fs.mkdirSync(path.dirname(realAuth), { recursive: true });
  fs.copyFileSync(privateAuth, realAuth);
  fs.chmodSync(realAuth, 0o600);
  return true;
}

/** Force `linkPath` to be a symlink to `target` (absolute). Replaces a regular file or broken link. */
export function ensureAuthSymlink(linkPath: string, target: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() && fs.readlinkSync(linkPath) === target) return;
  } catch (e) {
    if (!isErrnoCode(e, "ENOENT")) throw e;
  }
  try {
    fs.unlinkSync(linkPath);
  } catch (e) {
    if (!isErrnoCode(e, "ENOENT")) throw e;
  }
  fs.symlinkSync(target, linkPath);
}

/**
 * Discover private Grok homes under this workspace (bridge-mcp `*.grok` + harness agent `/.grok`).
 * Pure path scan — does not create directories.
 */
export function listWorkspaceGrokPrivateHomes(workspaceRoot: string): string[] {
  const homes: string[] = [];
  const bridgeRoot = bridgeMcpRoot(workspaceRoot);
  try {
    for (const ent of fs.readdirSync(bridgeRoot, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name.endsWith(".grok")) {
        homes.push(path.join(bridgeRoot, ent.name));
      }
    }
  } catch (e) {
    if (!isErrnoCode(e, "ENOENT")) throw e;
  }
  const hRoot = harnessRoot(workspaceRoot);
  try {
    for (const ent of fs.readdirSync(hRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const grokHome = path.join(hRoot, ent.name, ".grok");
      try {
        if (fs.statSync(grokHome).isDirectory()) homes.push(grokHome);
      } catch {
        /* no .grok under this harness agent */
      }
    }
  } catch (e) {
    if (!isErrnoCode(e, "ENOENT")) throw e;
  }
  return homes;
}

/**
 * Workspace-wide Grok auth reconcile (fix multi-agent re-login wall):
 * 1. Harvest every private regular `auth.json` (symlink replacements from Grok token refresh).
 * 2. Promote the freshest credential (OIDC create_time, then mtime) into the real `~/.grok/auth.json`.
 * 3. Re-symlink every private home to that single real file so all agents share one live token.
 *
 * Safe to call when no private homes exist. Fail-closed if real auth is missing after harvest
 * (caller still cannot spawn without `grok login` once).
 */
export function reconcileWorkspaceGrokAuth(workspaceRoot: string, realGrokHome: string): { promoted: boolean; relinked: number } {
  const realAuth = path.join(realGrokHome, "auth.json");
  const privateHomes = listWorkspaceGrokPrivateHomes(workspaceRoot);
  let promoted = false;
  let bestPrivate: string | undefined;
  // t-381750 — must match AuthCredentialRank after t-6c8437 (expiresAtMs + accessValid).
  let bestRank: AuthCredentialRank = { mtimeMs: 0, createTimeMs: 0, expiresAtMs: 0, accessValid: false };

  for (const home of privateHomes) {
    const privateAuth = path.join(home, "auth.json");
    let st: fs.Stats;
    try {
      st = fs.lstatSync(privateAuth);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    if (!isReadableJsonObjectFile(privateAuth)) continue;
    const rank = authCredentialRank(privateAuth);
    if (!bestPrivate || authRankBetter(rank, bestRank)) {
      bestPrivate = privateAuth;
      bestRank = rank;
    }
  }

  if (bestPrivate) {
    promoted = promoteNewerPrivateAuth(bestPrivate, realAuth);
    // Even if mtime/create_time tie-break said "not newer", still ensure real exists when only private had content.
    if (!fs.existsSync(realAuth) && isReadableJsonObjectFile(bestPrivate)) {
      fs.mkdirSync(path.dirname(realAuth), { recursive: true });
      fs.copyFileSync(bestPrivate, realAuth);
      fs.chmodSync(realAuth, 0o600);
      promoted = true;
    }
  }

  if (!fs.existsSync(realAuth)) return { promoted, relinked: 0 };

  let relinked = 0;
  for (const home of privateHomes) {
    const privateAuth = path.join(home, "auth.json");
    // Only touch homes that already have (or had) an auth path — avoid creating empty agent dirs.
    try {
      fs.lstatSync(privateAuth);
    } catch {
      continue;
    }
    ensureAuthSymlink(privateAuth, realAuth);
    relinked += 1;
  }
  return { promoted, relinked };
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
 * t-843576 — private `GROK_HOME` for a NON-harness grok agent. Grok reads MCP from
 * `$GROK_HOME/config.toml` and auth from `$GROK_HOME/auth.json`; Tachyon materializes a per-agent
 * home under bridge-mcp (never mutates the user's real `~/.grok/config.toml`) and injects
 * `GROK_HOME=<path>` at spawn. Distinct dirname from the claude/opencode bridge files so a shared
 * agent name never collides across runtimes.
 */
export function bridgeGrokHome(workspaceRoot: string, agent: string): string {
  return path.join(bridgeMcpRoot(workspaceRoot), `${agent}.grok`);
}

/**
 * Seed Grok's native folder-trust store (`$GROK_HOME/trusted_folders.toml`) so the interactive
 * "Do you trust the contents of this directory?" gate does not block a Tachyon-managed spawn.
 *
 * Mirrors Claude's `hasTrustDialogAccepted` seed in `materializeHome`. Each private GROK_HOME is
 * isolated from `~/.grok`, so a grant in the real home never reaches bridge-mcp / harness agents —
 * without this, every new Grok agent (and every wiped private home) forces a manual `y`.
 *
 * Only absolute, non-root, non-home paths are recorded (matches Grok's refuse-over-broad guard).
 * Existing `trusted = true` entries are left intact; untrusted/missing entries are upgraded.
 */
export function seedGrokTrustedFolders(
  home: string,
  folders: readonly string[],
  nowSec: number = Math.floor(Date.now() / 1000),
  homeDir: string = os.homedir(),
  mode: "merge" | "replace" = "merge",
): void {
  const absolute = uniqueAbsoluteFolders(folders, homeDir);
  if (absolute.length === 0) return;
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "trusted_folders.toml");
  let content = "";
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    /* cold private home */
  }

  if (mode === "replace") {
    const blocks = absolute.map((folder) => {
      const re = new RegExp(`\\[folders\\."${escapeRegExp(folder)}"\\]([^\\[]*)`, "m");
      const prior = content.match(re)?.[1] ?? "";
      const decidedAt = prior.match(/^\s*decided_at\s*=\s*(\d+)\b/m)?.[1] ?? String(nowSec);
      return `[folders."${folder}"]\ntrusted = true\ndecided_at = ${decidedAt}\n`;
    });
    const exact = blocks.join("");
    if (content !== exact) fs.writeFileSync(file, exact, "utf8");
    return;
  }

  let changed = false;
  for (const folder of absolute) {
    const header = `[folders."${folder}"]`;
    const re = new RegExp(`\\[folders\\."${escapeRegExp(folder)}"\\]([^\\[]*)`, "m");
    const match = content.match(re);
    if (match && /^\s*trusted\s*=\s*true\b/m.test(match[1] ?? "")) continue;
    const body = `trusted = true\ndecided_at = ${nowSec}\n`;
    if (match) {
      content = content.replace(re, `${header}\n${body}`);
    } else {
      const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
      content = `${content}${sep}${header}\n${body}`;
    }
    changed = true;
  }
  if (!changed && content.length > 0) return;
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  fs.writeFileSync(file, content, "utf8");
}

function uniqueAbsoluteFolders(folders: readonly string[], homeDir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const homeResolved = path.resolve(homeDir);
  for (const raw of folders) {
    if (!raw || typeof raw !== "string") continue;
    const folder = path.resolve(raw);
    if (!path.isAbsolute(folder)) continue;
    if (folder === path.parse(folder).root || folder === homeResolved) continue;
    if (seen.has(folder)) continue;
    seen.add(folder);
    out.push(folder);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Private `HERMES_HOME` for a NON-harness hermes agent. Hermes reads MCP from
 * `$HERMES_HOME/config.yaml` (`mcp_servers`) and OAuth from `$HERMES_HOME/auth.json`.
 * Distinct dirname so a shared agent name never collides with grok/claude bridge files.
 */
export function bridgeHermesHome(workspaceRoot: string, agent: string): string {
  return path.join(bridgeMcpRoot(workspaceRoot), `${agent}.hermes`);
}

/** True when `p` is a Tachyon-managed private Hermes home (bridge-mcp or harness). */
export function isTachyonManagedHermesHome(p: string): boolean {
  const n = path.resolve(p).replace(/\\/g, "/");
  return n.includes("/.tachyon/bridge-mcp/") || n.includes("/.tachyon/harness/");
}

/**
 * Real Hermes home used as the **auth/config source** for private homes.
 * Honors `HERMES_HOME` unless it is a Tachyon-managed private path.
 */
export function defaultRealHermesHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env.HERMES_HOME?.trim();
  if (override && override.length > 0 && !isTachyonManagedHermesHome(override)) return override;
  return path.join(homeDir, ".hermes");
}

/** Fail-closed: private HERMES_HOME must resolve to a readable auth.json object. */
export function assertReadableHermesAuth(agent: string, privateHome: string, realAuthTarget: string): void {
  const authPath = path.join(privateHome, "auth.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("auth.json is not a JSON object");
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new HarnessUnavailableError(
      agent,
      `hermes credentials unreadable at ${authPath} (source ${realAuthTarget}): ${detail} — run hermes auth / hermes model first (a redirected HERMES_HOME starts logged out)`,
    );
  }
}

/**
 * Merge `mcp_servers.<name>` into a Hermes `config.yaml` body. Bearer stays a literal
 * `${TACHYON_AGENT_BRIDGE_TOKEN}` ref (Hermes expands `${VAR}` at connect time).
 * Pure string helper — unit-tested without fs.
 */
export function setHermesMcpServer(
  yamlText: string | undefined,
  name: string,
  server: { url?: string; headers?: Record<string, string>; enabled?: boolean },
): string {
  let doc: Record<string, unknown> = {};
  if (yamlText && yamlText.trim().length > 0) {
    try {
      const parsed = parseYaml(yamlText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        doc = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      doc = {};
    }
  }
  const existing =
    doc.mcp_servers && typeof doc.mcp_servers === "object" && !Array.isArray(doc.mcp_servers)
      ? { ...(doc.mcp_servers as Record<string, unknown>) }
      : {};
  const entry: Record<string, unknown> = { enabled: server.enabled ?? true };
  if (server.url) entry.url = server.url;
  if (server.headers && Object.keys(server.headers).length > 0) entry.headers = { ...server.headers };
  existing[name] = entry;
  doc.mcp_servers = existing;
  return stringifyYaml(doc);
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

/** Pi's ambient user home is only a seed source. Never seed a sibling from a Tachyon private home. */
export function defaultRealPiHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env[PI_AGENT_DIR_ENV]?.trim();
  if (override && !path.resolve(override).replace(/\\/g, "/").includes("/.tachyon/harness/")) return override;
  return path.join(homeDir, ".pi", "agent");
}

const PI_PRIVATE_JSON_FILES = [
  "auth.json",
  "settings.json",
  "models.json",
  "models-store.json",
  "trust.json",
  "keybindings.json",
] as const;
const PI_EXECUTABLE_RESOURCE_SETTINGS = ["packages", "extensions", "skills", "prompts", "themes"] as const;
const PI_RESOURCE_ROOT = ".tachyon-resources";
const PROFILE_CAPABILITY_ROOT = ".tachyon-profile-capabilities";
const PI_RESOURCE_DISABLE_ARGS = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"] as const;

type PiResourceKind = "extensions" | "skills" | "prompts" | "themes" | "packages";

function shellResourcePath(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * t-303f2b — true when `p` looks like a Tachyon-managed private Grok home (bridge-mcp or harness),
 * not the user's real login home. A process that inherits `GROK_HOME` from a redirected agent pane
 * must not treat that private dir as the credential *source* for new agents (cold homes without a
 * readable auth.json → browser login wall).
 */
export function isTachyonManagedGrokHome(p: string): boolean {
  const n = path.resolve(p).replace(/\\/g, "/");
  return n.includes("/.tachyon/bridge-mcp/") || n.includes("/.tachyon/harness/");
}

/**
 * The real Grok config home used as the **auth source** for private homes. Grok documents `GROK_HOME`
 * (default `~/.grok`). Honors an explicit override unless it is a Tachyon-managed private path
 * (t-303f2b) — those must never be the seed for sibling agents.
 */
export function defaultRealGrokHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env.GROK_HOME?.trim();
  if (override && override.length > 0 && !isTachyonManagedGrokHome(override)) return override;
  return path.join(homeDir, ".grok");
}

/** Fail-closed: private GROK_HOME must resolve to a readable auth.json object (t-303f2b). */
export function assertReadableGrokAuth(agent: string, privateHome: string, realAuthTarget: string): void {
  const authPath = path.join(privateHome, "auth.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("auth.json is not a JSON object");
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new HarnessUnavailableError(
      agent,
      `grok credentials unreadable at ${authPath} (source ${realAuthTarget}): ${detail} — run grok login first (a redirected GROK_HOME starts logged out)`,
    );
  }
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
  /** t-6c8437 — throttle in-session harvest so agent-list ticks stay cheap. */
  private lastGrokHarvestMs = 0;
  private static readonly GROK_HARVEST_MIN_INTERVAL_MS = 5_000;

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
    /** Source Grok home for auth/config seeding. */
    private readonly realGrokHome: string = defaultRealGrokHome(procEnv),
    /** Source Hermes home for auth/config seeding. */
    private readonly realHermesHome: string = defaultRealHermesHome(procEnv),
    /** Source Pi home for private regular-file config/auth snapshots. */
    private readonly realPiHome: string = defaultRealPiHome(procEnv),
  ) {}

  home(agent: string): string {
    return harnessHome(this.workspaceRoot, agent);
  }

  /** Materialize a canonical-profile capability snapshot through the measured runtime adapter only. */
  materializeProfileCapabilities(
    agent: string,
    projection: ResolvedAgentCapabilityProjection,
    adapter: ResumeAdapter,
    cwd?: string,
    bridgeEntry?: Record<string, unknown>,
  ): MaterializedHarness {
    if (projection.adapter !== adapter.runtime) {
      throw new HarnessUnavailableError(agent, `capability snapshot targets '${projection.adapter}', not '${adapter.runtime}'`);
    }
    if (adapter.runtime === "pi") return this.materializePiProfileHome(agent, projection, cwd);
    if (adapter.runtime !== "codex") {
      throw new HarnessUnavailableError(agent, `runtime '${adapter.runtime}' has no measured profile capability projection`);
    }
    return this.materializeCanonicalCodexProfileHome(agent, adapter, { capabilities: projection }, cwd, bridgeEntry);
  }

  private ensureProfileCapabilityRoot(agent: string, home: string): string {
    const root = path.join(home, PROFILE_CAPABILITY_ROOT);
    try {
      const stat = fs.lstatSync(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new HarnessUnavailableError(agent, `profile capability metadata root must be a real directory: ${root}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(root, { mode: 0o700 });
    }
    return root;
  }

  private writeCapturedCapability(agent: string, source: CapturedCapabilitySource, target: string): void {
    if (source.type === "file") {
      const entry = source.entries.find((candidate) => candidate.type === "file" && candidate.path === ".");
      if (!entry?.bytes) throw new HarnessUnavailableError(agent, `captured capability ${source.source} has no file bytes`);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, entry.bytes, { flag: "wx", mode: entry.mode });
      return;
    }
    fs.mkdirSync(target, { mode: 0o700 });
    for (const entry of source.entries) {
      if (entry.path === ".") {
        fs.chmodSync(target, entry.mode);
        continue;
      }
      const segments = entry.path.split("/");
      if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new HarnessUnavailableError(agent, `captured capability contains an unsafe path: ${entry.path}`);
      }
      const destination = path.join(target, ...segments);
      const relative = path.relative(target, destination);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new HarnessUnavailableError(agent, `captured capability escapes its projection root: ${entry.path}`);
      }
      if (entry.type === "directory") {
        fs.mkdirSync(destination, { mode: entry.mode });
      } else {
        if (!entry.bytes) throw new HarnessUnavailableError(agent, `captured capability file has no bytes: ${entry.path}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.writeFileSync(destination, entry.bytes, { flag: "wx", mode: entry.mode });
      }
    }
  }

  private replaceCapturedSkillTree(agent: string, home: string, projection: ResolvedAgentCapabilityProjection): void {
    const target = path.join(home, "skills");
    const stage = path.join(home, `.skills-staging-${randomUUID()}`);
    const prior = path.join(home, `.skills-prior-${randomUUID()}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    try {
      for (const skill of projection.skills) this.writeCapturedCapability(agent, skill.source, path.join(stage, skill.name));
      let hadPrior = false;
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new HarnessUnavailableError(agent, `profile skill projection target must be a real directory: ${target}`);
        }
        fs.renameSync(target, prior);
        hadPrior = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        fs.renameSync(stage, target);
      } catch (error) {
        if (hadPrior) fs.renameSync(prior, target);
        throw error;
      }
      if (hadPrior) removeDirByRenameThenRm(prior);
    } catch (error) {
      removeDirByRenameThenRm(stage);
      throw error;
    }
  }

  private writeProfileCapabilityManifest(agent: string, home: string, projection: ResolvedAgentCapabilityProjection): void {
    const root = this.ensureProfileCapabilityRoot(agent, home);
    const manifest = {
      schemaVersion: 1,
      adapter: projection.adapter,
      effectiveProfileSha256: projection.effectiveProfileSha256 ?? null,
      capabilityProjectionSha256: projection.sha256,
      sources: projection.sources,
      outputs: {
        skills: projection.skills.map((entry) => ({ name: entry.name, sha256: entry.source.sha256 })),
        mcp: Object.keys(projection.mcp).sort(),
        hooks: Object.keys(projection.hooks).sort(),
        pi: Object.fromEntries(Object.entries(projection.pi).map(([kind, entries]) => [kind, entries.map((entry) => ({ name: entry.name, sha256: entry.source.sha256 }))])),
      },
    };
    atomicWrite(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /**
   * Materialize Pi's complete default private home. Snapshot only inert top-level JSON state; executable
   * global resource trees deliberately do not cross this boundary. Existing private files belong to Pi
   * and are validated/preserved so OAuth refresh and `/settings` writes survive restart/resume.
   */
  materializePiHomeOnly(agent: string, options: { exactTrustCwd?: string } = {}): MaterializedHarness {
    // Prior content-addressed harness generations remain inert: without explicit CLI paths Pi cannot
    // discover this hidden subtree. Keeping them avoids mutating a still-live process during fallible
    // restart preparation; canonical forget removes the complete private home.
    return this.materializePiBaseHome(agent, options);
  }

  /** SDD 406 — materialize an exact, agent-local Pi resource catalog without mutating private settings. */
  materializePiHome(agent: string, def: HarnessDef, options: { exactTrustCwd?: string } = {}): MaterializedHarness {
    const base = this.materializePiBaseHome(agent, options);
    const root = path.join(base.home, PI_RESOURCE_ROOT);
    this.ensurePiResourceDir(agent, root);
    this.cleanPiStagingDirs(agent, root);

    const stageName = `.staging-${randomUUID()}`;
    const stage = path.join(root, stageName);
    fs.mkdirSync(stage, { mode: 0o700 });

    const args: string[] = [...PI_RESOURCE_DISABLE_ARGS];
    try {
      const fields: Array<[PiResourceKind, string[] | undefined]> = [
        ["extensions", def.extensions],
        ["skills", def.skills],
        ["prompts", def.prompts],
        ["themes", def.themes],
        ["packages", def.packages],
      ];
      for (const [kind, declared] of fields) {
        if (!declared || declared.length === 0) continue;
        const targetRoot = path.join(stage, kind);
        fs.mkdirSync(targetRoot, { mode: 0o700 });
        const seen = new Set<string>();
        for (const rel of declared) {
          const source = this.resolveInWorkspace(agent, rel, `Pi ${kind} resource`);
          const baseName = path.basename(source);
          if (seen.has(baseName)) {
            throw new HarnessUnavailableError(agent, `duplicate Pi ${kind} resource basename '${baseName}' (${rel})`);
          }
          seen.add(baseName);
          const target = path.join(targetRoot, baseName);
          const explicitPath = this.copyPiResource(agent, kind, rel, source, target);
          const flag = kind === "skills"
            ? "--skill"
            : kind === "prompts"
              ? "--prompt-template"
              : kind === "themes"
                ? "--theme"
                : "--extension";
          args.push(flag, shellResourcePath(explicitPath));
        }
      }

      const generationDigest = this.hashPiResourceTree(agent, stage);
      const generationName = `generation-${generationDigest}`;
      const generation = path.join(root, generationName);
      this.publishPiResourceGeneration(agent, root, stage, generation, generationDigest);
      const rewritten = args.map((arg) => arg.includes(stage) ? arg.replace(stage, generation) : arg);
      return { ...base, args: rewritten };
    } catch (error) {
      removeRecursiveWithRetry(stage);
      throw error;
    }
  }

  private materializePiProfileHome(
    agent: string,
    projection: ResolvedAgentCapabilityProjection,
    cwd?: string,
  ): MaterializedHarness {
    const base = this.materializePiBaseHome(agent, { exactTrustCwd: cwd ?? this.workspaceRoot });
    const root = path.join(base.home, PI_RESOURCE_ROOT);
    this.ensurePiResourceDir(agent, root);
    this.cleanPiStagingDirs(agent, root);
    const stage = path.join(root, `.staging-${randomUUID()}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    const args: string[] = [...PI_RESOURCE_DISABLE_ARGS];
    try {
      const fields: Array<[PiResourceKind, Array<{ name: string; source: CapturedCapabilitySource }>]> = [
        ["extensions", projection.pi.extensions],
        ["skills", projection.skills],
        ["prompts", projection.pi.prompts],
        ["themes", projection.pi.themes],
        ["packages", projection.pi.packages],
      ];
      for (const [kind, entries] of fields) {
        if (entries.length === 0) continue;
        const targetRoot = path.join(stage, kind);
        fs.mkdirSync(targetRoot, { mode: 0o700 });
        for (const entry of entries) {
          const target = path.join(targetRoot, entry.name);
          this.writeCapturedCapability(agent, entry.source, target);
          let explicitPath = target;
          if (kind === "extensions" && entry.source.type === "tree") {
            const index = entry.source.entries.find((candidate) => candidate.type === "file" && ["index.ts", "index.js"].includes(candidate.path));
            if (!index) throw new HarnessUnavailableError(agent, `captured Pi extension ${entry.name} has no root entrypoint`);
            explicitPath = path.join(target, index.path);
          }
          const flag = kind === "skills"
            ? "--skill"
            : kind === "prompts"
              ? "--prompt-template"
              : kind === "themes"
                ? "--theme"
                : "--extension";
          args.push(flag, shellResourcePath(explicitPath));
        }
      }
      const generationDigest = this.hashPiResourceTree(agent, stage);
      const generation = path.join(root, `generation-${generationDigest}`);
      this.publishPiResourceGeneration(agent, root, stage, generation, generationDigest);
      const rewritten = args.map((arg) => arg.includes(stage) ? arg.replace(stage, generation) : arg);
      this.writeProfileCapabilityManifest(agent, base.home, projection);
      return { ...base, args: rewritten };
    } catch (error) {
      removeDirByRenameThenRm(stage);
      throw error;
    }
  }

  private materializePiBaseHome(agent: string, options: { exactTrustCwd?: string } = {}): MaterializedHarness {
    const home = materializePiAgentHome(this.workspaceRoot, agent);
    const exactTrust = options.exactTrustCwd === undefined
      ? undefined
      : [...new Set([this.workspaceRoot, options.exactTrustCwd].map((folder) => fs.realpathSync(folder)))];

    for (const fileName of PI_PRIVATE_JSON_FILES) {
      const source = path.join(this.realPiHome, fileName);
      const target = path.join(home, fileName);
      let sourceExists = false;
      if (fileName !== "trust.json" || exactTrust === undefined) {
        try {
          const stat = fs.lstatSync(source);
          sourceExists = true;
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new HarnessUnavailableError(agent, `Pi seed source must be a regular no-follow file: ${source}`);
          }
          if (!isReadableJsonObjectFile(source)) {
            throw new HarnessUnavailableError(agent, `Pi seed source is not a readable JSON object: ${source}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      let targetExists = false;
      try {
        const stat = fs.lstatSync(target);
        targetExists = true;
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new HarnessUnavailableError(agent, `Pi private-home target must be a regular no-follow file: ${target}`);
        }
        if (!isReadableJsonObjectFile(target)) {
          throw new HarnessUnavailableError(agent, `Pi private-home target is not a readable JSON object: ${target}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      if (!targetExists && sourceExists) {
        try {
          if (fileName === "settings.json") {
            const snapshot = JSON.parse(fs.readFileSync(source, "utf8")) as Record<string, unknown>;
            for (const key of PI_EXECUTABLE_RESOURCE_SETTINGS) delete snapshot[key];
            fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          } else {
            fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const stat = fs.lstatSync(target);
          if (stat.isSymbolicLink() || !stat.isFile() || !isReadableJsonObjectFile(target)) {
            throw new HarnessUnavailableError(agent, `concurrent Pi private-home seed produced an unsafe target: ${target}`);
          }
        }
      }
      try {
        const finalStat = fs.lstatSync(target);
        if (finalStat.isSymbolicLink() || !finalStat.isFile() || !isReadableJsonObjectFile(target)) {
          throw new HarnessUnavailableError(agent, `Pi private-home target failed final validation: ${target}`);
        }
        fs.chmodSync(target, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    if (exactTrust !== undefined) {
      const trustPath = path.join(home, "trust.json");
      const trust = Object.fromEntries(exactTrust.map((folder) => [folder, true]));
      atomicWrite(trustPath, `${JSON.stringify(trust, null, 2)}\n`, 0o600);
      fs.chmodSync(trustPath, 0o600);
      const stat = fs.lstatSync(trustPath);
      if (stat.isSymbolicLink() || !stat.isFile() || !isReadableJsonObjectFile(trustPath)) {
        throw new HarnessUnavailableError(agent, `Pi exact trust target failed final validation: ${trustPath}`);
      }
    }

    const sessions = materializePiSessionDir(this.workspaceRoot, agent);
    return {
      home,
      env: { [PI_AGENT_DIR_ENV]: home, [PI_SESSION_DIR_ENV]: sessions },
      args: [],
    };
  }

  private ensurePiResourceDir(agent: string, root: string): void {
    try {
      const stat = fs.lstatSync(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new HarnessUnavailableError(agent, `Pi resource root must be a real directory: ${root}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(root, { mode: 0o700 });
    }
    fs.chmodSync(root, 0o700);
  }

  private publishPiResourceGeneration(agent: string, root: string, stage: string, generation: string, digest: string): void {
    try {
      const existing = fs.lstatSync(generation);
      let intact = false;
      if (!existing.isSymbolicLink() && existing.isDirectory()) {
        try { intact = this.hashPiResourceTree(agent, generation) === digest; }
        catch { intact = false; }
      }
      if (intact) {
        removeDirByRenameThenRm(stage);
        return;
      }
      const prior = path.join(root, `.corrupt-${digest}-${randomUUID()}`);
      fs.renameSync(generation, prior);
      try {
        fs.renameSync(stage, generation);
      } catch (error) {
        fs.renameSync(prior, generation);
        throw error;
      }
      removeDirByRenameThenRm(prior);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.renameSync(stage, generation);
    }
  }

  private cleanPiStagingDirs(agent: string, root: string): void {
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(".staging-")) continue;
      const item = path.join(root, name);
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new HarnessUnavailableError(agent, `Pi resource staging entry must be a real directory: ${item}`);
      }
      removeDirByRenameThenRm(item);
    }
  }

  private copyPiResource(agent: string, kind: PiResourceKind, declared: string, source: string, target: string): string {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(source);
    } catch {
      throw new HarnessUnavailableError(agent, `Pi ${kind} resource not found: ${declared}`);
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new HarnessUnavailableError(agent, `Pi ${kind} resource must be a regular no-follow file or directory: ${declared}`);
    }

    let explicitSource = source;
    if (kind === "extensions") {
      if (stat.isFile()) {
        if (![".ts", ".js"].includes(path.extname(source))) {
          throw new HarnessUnavailableError(agent, `Pi extension file must end in .ts or .js: ${declared}`);
        }
      } else {
        const entry = ["index.ts", "index.js"].map((name) => path.join(source, name)).find((file) => {
          try {
            const entryStat = fs.lstatSync(file);
            return entryStat.isFile() && !entryStat.isSymbolicLink();
          } catch {
            return false;
          }
        });
        if (!entry) throw new HarnessUnavailableError(agent, `Pi extension directory must contain index.ts or index.js: ${declared}`);
        explicitSource = entry;
      }
    } else if (kind === "skills") {
      if (!stat.isDirectory() || !isReadableRegularFile(path.join(source, "SKILL.md"))) {
        throw new HarnessUnavailableError(agent, `Pi skill directory must contain a regular SKILL.md: ${declared}`);
      }
    } else if (kind === "prompts") {
      if (!stat.isFile() || path.extname(source) !== ".md") {
        throw new HarnessUnavailableError(agent, `Pi prompt template must be a .md file: ${declared}`);
      }
    } else if (kind === "themes") {
      if (!stat.isFile() || path.extname(source) !== ".json" || !isReadableNoFollowJsonObjectFile(source)) {
        throw new HarnessUnavailableError(agent, `Pi theme must be a readable JSON-object file: ${declared}`);
      }
    } else if (!stat.isDirectory() || !this.isPiPackageRoot(source)) {
      throw new HarnessUnavailableError(agent, `Pi package must be a local directory with a pi manifest or conventional resource directory: ${declared}`);
    }

    this.copyNoFollowTree(agent, source, target, declared);
    return explicitSource === source ? target : path.join(target, path.relative(source, explicitSource));
  }

  private isPiPackageRoot(source: string): boolean {
    const manifest = path.join(source, "package.json");
    if (isReadableNoFollowJsonObjectFile(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
        if (parsed.pi && typeof parsed.pi === "object" && !Array.isArray(parsed.pi)) {
          const pi = parsed.pi as Record<string, unknown>;
          let resourceCount = 0;
          for (const key of ["extensions", "skills", "prompts", "themes"]) {
            const entries = pi[key];
            if (entries === undefined) continue;
            if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string"
              || !this.isSafePiPackageEntry(entry) || !this.isValidPiPackageEntry(source, key, entry))) {
              return false;
            }
            resourceCount += entries.length;
          }
          return resourceCount > 0;
        }
      } catch {
        return false;
      }
    }
    let resourceCount = 0;
    for (const name of ["extensions", "skills", "prompts", "themes"]) {
      const root = path.join(source, name);
      try {
        const stat = fs.lstatSync(root);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        const entries = fs.readdirSync(root);
        if (entries.length === 0 || entries.some((entry) => !this.isValidPiPackageEntry(source, name, `${name}/${entry}`))) return false;
        resourceCount += entries.length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    return resourceCount > 0;
  }

  private isSafePiPackageEntry(entry: string): boolean {
    const candidate = entry.replace(/^[!+-]/, "").trim();
    return candidate.length > 0
      && !candidate.includes("\0")
      && !candidate.includes("..")
      && !path.isAbsolute(candidate)
      && !candidate.startsWith("~")
      && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)
      && !/^[A-Za-z]:[\\/]/.test(candidate);
  }

  private isValidPiPackageEntry(source: string, kind: string, entry: string): boolean {
    const candidate = entry.replace(/^[!+-]/, "").trim();
    if (!this.isSafePiPackageEntry(entry)) return false;
    const target = path.resolve(source, candidate);
    const relative = path.relative(source, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    const validLeaf = (item: string): boolean => {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(item); }
      catch { return false; }
      if (stat.isSymbolicLink()) return false;
      if (kind === "extensions") {
        if (stat.isFile()) return [".ts", ".js"].includes(path.extname(item));
        if (!stat.isDirectory()) return false;
        return ["index.ts", "index.js"].some((name) => {
          try {
            const index = fs.lstatSync(path.join(item, name));
            return index.isFile() && !index.isSymbolicLink();
          } catch { return false; }
        });
      }
      if (kind === "skills") {
        if (!stat.isDirectory()) return false;
        try {
          const skill = fs.lstatSync(path.join(item, "SKILL.md"));
          return skill.isFile() && !skill.isSymbolicLink();
        } catch { return false; }
      }
      if (kind === "prompts") return stat.isFile() && path.extname(item) === ".md";
      return kind === "themes" && stat.isFile() && path.extname(item) === ".json" && isReadableNoFollowJsonObjectFile(item);
    };
    if (validLeaf(target)) return true;
    let targetStat: fs.Stats;
    try { targetStat = fs.lstatSync(target); }
    catch { return false; }
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) return false;
    let children: string[];
    try { children = fs.readdirSync(target); }
    catch { return false; }
    return children.length > 0 && children.every((name) => validLeaf(path.join(target, name)));
  }

  private copyNoFollowTree(agent: string, source: string, target: string, declared: string): void {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new HarnessUnavailableError(agent, `Pi resource tree contains a symlink or special file: ${declared}`);
    }
    if (stat.isFile()) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, stat.mode & 0o777);
      return;
    }
    fs.mkdirSync(target, { mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      this.copyNoFollowTree(agent, path.join(source, entry), path.join(target, entry), `${declared}/${entry}`);
    }
  }

  private hashPiResourceTree(agent: string, root: string): string {
    const hash = createHash("sha256");
    const visit = (current: string, relative: string): void => {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new HarnessUnavailableError(agent, `Pi resource generation contains a symlink or special file: ${current}`);
      }
      hash.update(`${stat.isDirectory() ? "d" : "f"}:${relative}:${stat.mode & 0o777}\0`);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current).sort()) visit(path.join(current, entry), path.join(relative, entry));
      } else {
        hash.update(fs.readFileSync(current));
      }
    };
    visit(root, ".");
    return hash.digest("hex").slice(0, 24);
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
  materialize(
    agent: string,
    def: HarnessDef,
    adapter: ResumeAdapter,
    cwd?: string,
    bridgeEntry?: Record<string, unknown>,
    lifecycle?: { handoffPath?: string; silentPersistence?: boolean },
    profileCapabilities?: ResolvedAgentCapabilityProjection,
  ): MaterializedHarness {
    const h = adapter.harness;
    if (!h) throw new Error(`runtime '${adapter.runtime}' does not support an isolated harness`);
    if (profileCapabilities && (profileCapabilities.adapter !== "codex" || adapter.runtime !== "codex")) {
      throw new HarnessUnavailableError(agent, `profile capability snapshot cannot be consumed by '${adapter.runtime}'`);
    }

    // H7 — resolve the ${VAR} secret refs BEFORE any fs side effect, and fail closed if one is missing:
    // claude expands ${VAR} from the spawned PROCESS env (not the mcp.json file), so the real value must
    // be injected there. spec 227 — source = the ambient process env OR a project `.env` (gitignored),
    // process.env taking precedence (dotenv semantics) so the common case needs no shell export.
    const secretEnv = this.resolveMcpSecretEnv(agent, def);

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
    if (profileCapabilities) {
      const manifest = path.join(this.ensureProfileCapabilityRoot(agent, home), "manifest.json");
      fs.rmSync(manifest, { force: true });
    }

    // mcp — ALWAYS scope a harness agent. Claude gets a strict `mcp.json` + flags; Codex gets a private
    // `config.toml` under CODEX_HOME; opencode (XDG) gets `opencode/opencode.json` under XDG_CONFIG_HOME.
    // In all cases inherit:none excludes workspace MCP; inherit:workspace snapshots the workspace runtime
    // config into the private home. H7: ${VAR} stays literal on disk.
    const workspaceServers = def.inherit === "workspace" ? readWorkspaceMcpServers(this.workspaceRoot) : null;
    const mergedServers = mergeServers(def, workspaceServers, bridge);
    const args = this.materializeMcpConfig(agent, def, adapter, home, mergedServers, bridge);
    if (adapter.runtime === "grok") {
      this.materializeGrokLifecycleHooks(agent, home, lifecycle?.handoffPath ?? path.join(this.workspaceRoot, ".tachyon", "HANDOFF.md"), {
        silentPersistence: lifecycle?.silentPersistence ?? true,
      });
      this.materializeSkills(agent, def, home);
      return { home, env: { [h.configHomeEnv]: this.grokHome(home), ...secretEnv }, args };
    }
    if (adapter.runtime === "hermes") {
      // HERMES_HOME is the harness home itself (config.yaml + auth + skills under the same root).
      this.materializeSkills(agent, def, home);
      return { home, env: { [h.configHomeEnv]: home, ...secretEnv }, args };
    }
    if (adapter.runtime === "codex") {
      this.materializeCodexInstructions(agent, def, home);
      if (profileCapabilities) this.replaceCapturedSkillTree(agent, home, profileCapabilities);
      else this.materializeSkills(agent, def, home);
      if (profileCapabilities) this.writeProfileCapabilityManifest(agent, home, profileCapabilities);
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
    // Grok: harvest private regular auth.json files first (token refresh replaces the symlink).
    if (adapter.runtime === "grok") {
      this.reconcileGrokAuthFromWorkspace();
    }
    const authSourceHome =
      adapter.runtime === "codex"
        ? this.realCodexHome
        : adapter.runtime === "grok"
          ? this.realGrokHome
          : adapter.runtime === "hermes"
            ? this.realHermesHome
            : this.realHome;
    const authDestHome = adapter.runtime === "grok" ? this.grokHome(home) : home;
    for (const authFile of h.authFiles) {
      const authLink = path.join(authDestHome, authFile);
      const authTarget = path.join(authSourceHome, authFile);
      // Hermes may authenticate exclusively through provider API keys in `.env`/process env. Preserve
      // OAuth refreshes first, but do not require auth.json when no OAuth credential exists.
      if (adapter.runtime === "hermes") {
        promoteNewerPrivateAuth(authLink, authTarget);
      }
      if (!fs.existsSync(authTarget)) {
        if (adapter.runtime === "hermes") {
          fs.rmSync(authLink, { force: true });
          continue;
        }
        const login =
          adapter.runtime === "codex"
            ? "codex login"
            : adapter.runtime === "grok"
              ? "grok login"
              : "claude /login";
        throw new HarnessUnavailableError(agent, `no credentials at ${authTarget} — run ${login} first (a redirected config home starts logged out)`);
      }
      ensureAuthSymlink(authLink, authTarget);
    }

    if (adapter.runtime === "codex" || adapter.runtime === "grok" || adapter.runtime === "hermes") {
      // t-303f2b — harness/isolate-transcript private homes must also prove credentials before spawn.
      if (adapter.runtime === "grok") {
        assertReadableGrokAuth(agent, authDestHome, path.join(authSourceHome, "auth.json"));
        // Folder-trust is per GROK_HOME; private homes do not inherit ~/.grok grants.
        seedGrokTrustedFolders(authDestHome, [this.workspaceRoot, ...(cwd ? [cwd] : [])]);
      }
      if (adapter.runtime === "hermes") {
        const authTarget = path.join(authSourceHome, "auth.json");
        if (fs.existsSync(authTarget)) assertReadableHermesAuth(agent, authDestHome, authTarget);
        // Seed model/provider settings from the real home so a private HERMES_HOME is not blank.
        this.seedHermesConfigFromReal(authDestHome);
      }
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
  materializeHomeOnly(
    agent: string,
    adapter: ResumeAdapter,
    cwd?: string,
    options: { inheritNativeConfig?: boolean } = {},
  ): MaterializedHarness {
    const home = this.materializeHome(agent, adapter, cwd);
    const h = adapter.harness;
    if (!h) throw new Error(`runtime '${adapter.runtime}' does not support an isolated config home`);
    if (adapter.runtime === "codex") {
      if (options.inheritNativeConfig === false) fs.rmSync(path.join(home, "config.toml"), { force: true });
      else this.seedCodexHomeOnlyConfig(home);
    }
    if (adapter.runtime === "grok") return { home, env: { [h.configHomeEnv]: this.grokHome(home) }, args: [] };
    if (adapter.runtime === "hermes") return { home, env: { [h.configHomeEnv]: home }, args: [] };
    if (h.xdg) {
      // spec t-e2ebe3 — mirror materialize()'s xdg branch: point all three XDG vars at the subdirs
      // materializeHome already created/seeded, not the home root (else XDG_DATA_HOME/XDG_STATE_HOME
      // are simply absent and opencode falls back to the real, ambient, globally-shared locations).
      const dirs = opencodeHarnessDirs(home);
      return { home, env: { [h.configHomeEnv]: dirs.config, [h.xdg.dataEnv]: dirs.data, [h.xdg.stateEnv]: dirs.state }, args: [] };
    }
    return { home, env: { [h.configHomeEnv]: home }, args: [] };
  }

  /** Rebuild the closed, typed Codex selector projection on every canonical launch. */
  materializeCanonicalCodexHome(
    agent: string,
    adapter: ResumeAdapter,
    projection: ResolvedAgentNativeConfigProjection,
    cwd?: string,
  ): MaterializedHarness {
    return this.materializeCanonicalCodexProfileHome(agent, adapter, { nativeConfig: projection }, cwd);
  }

  /**
   * Materialize a canonical Codex profile as one private configuration. Native scalar policy and
   * capability selections are independent profile planes, but Codex reads both from the same
   * config home; writing either one separately would silently discard the other.
   */
  materializeCanonicalCodexProfileHome(
    agent: string,
    adapter: ResumeAdapter,
    projection: {
      nativeConfig?: ResolvedAgentNativeConfigProjection;
      capabilities?: ResolvedAgentCapabilityProjection;
    },
    cwd?: string,
    bridgeEntry?: Record<string, unknown>,
  ): MaterializedHarness {
    const nativeConfig = projection.nativeConfig;
    const capabilities = projection.capabilities;
    if (
      adapter.runtime !== "codex"
      || (nativeConfig && nativeConfig.adapter !== "codex")
      || (capabilities && capabilities.adapter !== "codex")
    ) {
      throw new Error(`runtime '${adapter.runtime}' is not compatible with the Codex native configuration projection`);
    }
    const home = this.materializeHome(agent, adapter, cwd);
    if (capabilities) {
      fs.rmSync(path.join(this.ensureProfileCapabilityRoot(agent, home), "manifest.json"), { force: true });
    }
    const configPath = path.join(home, "config.toml");
    const values: Array<[string, string | undefined]> = [
      ["model", nativeConfig?.selectors.model],
      ["model_provider", nativeConfig?.selectors.provider],
      ["model_reasoning_effort", nativeConfig?.selectors.reasoningEffort],
      ["service_tier", nativeConfig?.selectors.serviceTier],
      ["approval_policy", nativeConfig?.permissions?.approvalPolicy],
      ["sandbox_mode", nativeConfig?.permissions?.sandboxMode],
      ["personality", nativeConfig?.interface?.personality],
    ];
    const lines = values
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key} = ${tomlString(value)}`);
    if (nativeConfig?.interface?.statusLine !== undefined || nativeConfig?.interface?.statusLineUseColors !== undefined) {
      if (lines.length > 0) lines.push("");
      lines.push("[tui]");
      if (nativeConfig.interface.statusLine !== undefined) {
        lines.push(`status_line = ${tomlValue(nativeConfig.interface.statusLine)}`);
      }
      if (nativeConfig.interface.statusLineUseColors !== undefined) {
        lines.push(`status_line_use_colors = ${tomlValue(nativeConfig.interface.statusLineUseColors)}`);
      }
    }
    if (nativeConfig?.featureFlags?.terminalResizeReflow !== undefined) {
      if (lines.length > 0) lines.push("");
      lines.push("[features]");
      lines.push(`terminal_resize_reflow = ${tomlValue(nativeConfig.featureFlags.terminalResizeReflow)}`);
    }
    const trustedProjects = [...new Set([
      path.resolve(this.workspaceRoot),
      path.resolve(cwd ?? this.workspaceRoot),
    ])].sort();
    for (const project of trustedProjects) {
      if (lines.length > 0) lines.push("");
      lines.push(`[projects.${tomlString(project)}]`);
      lines.push('trust_level = "trusted"');
    }
    let content = lines.join("\n");
    if (capabilities) {
      const def: HarnessDef = {
        inherit: "none",
        ...(Object.keys(capabilities.mcp).length > 0 ? { mcp: capabilities.mcp } : {}),
        ...(Object.keys(capabilities.hooks).length > 0 ? { hooks: capabilities.hooks } : {}),
      };
      const bridge = bridgeEntry && typeof bridgeEntry.url === "string"
        ? { url: bridgeEntry.url, headers: bridgeEntry.headers }
        : undefined;
      for (const [name, server] of Object.entries(def.mcp ?? {})) {
        content = setCodexMcpServer(content, name, renderCodexMcpBlock({ name, transport: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? {} }));
      }
      if (bridge) {
        const headers = bridge.headers && typeof bridge.headers === "object" && !Array.isArray(bridge.headers) ? bridge.headers as Record<string, string> : {};
        content = setCodexMcpServer(content, "tachyon_bridge", renderCodexMcpBlock({ name: "tachyon_bridge", transport: "http", url: bridge.url, headers }));
      }
      if (def.hooks) content = appendCodexHooksConfig(content, def.hooks);
    }
    if (content.length > 0) atomicWrite(configPath, `${content}\n`);
    else fs.rmSync(configPath, { force: true });
    if (capabilities) {
      this.replaceCapturedSkillTree(agent, home, capabilities);
      this.writeProfileCapabilityManifest(agent, home, capabilities);
    }
    const secretEnv = capabilities ? this.resolveMcpSecretEnv(agent, { inherit: "none", mcp: capabilities.mcp }) : {};
    return { home, env: { CODEX_HOME: home, ...secretEnv }, args: [] };
  }

  private resolveMcpSecretEnv(agent: string, def: HarnessDef): Record<string, string> {
    const envFile = this.readEnvFile();
    const secretEnv: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of collectEnvRefs(def)) {
      const value = this.procEnv[name] ?? envFile[name];
      if (value === undefined || value === "") missing.push(name);
      else secretEnv[name] = value;
    }
    if (missing.length > 0) {
      throw new HarnessUnavailableError(agent, `set these env var(s) before starting it: ${missing.join(", ")} — in the project .env or your shell (referenced by an MCP server)`);
    }
    return secretEnv;
  }

  /**
   * Canonical Claude launch projection. The private home and user-only settings source preserve
   * external OAuth while excluding account/project/local settings and ambient tooling. The only MCP
   * authority retained here is the host-custodied Bridge; profile capabilities need their own projector.
   */
  materializeCanonicalClaudeHome(
    agent: string,
    adapter: ResumeAdapter,
    cwd?: string,
    projection?: ResolvedAgentNativeConfigProjection,
    bridgeEntry?: Record<string, unknown>,
  ): MaterializedHarness {
    if (adapter.runtime !== "claude") throw new Error(`runtime '${adapter.runtime}' is not Claude`);
    if (projection && projection.adapter !== "claude") {
      throw new HarnessUnavailableError(agent, `native configuration targets '${projection.adapter}', not 'claude'`);
    }
    const home = this.materializeHome(agent, adapter, cwd);
    this.materializeCanonicalClaudeBootstrap(home, cwd);

    for (const entry of ["CLAUDE.md", "settings.local.json", "mcp.json", "plugins", "agents", "commands", "skills"]) {
      fs.rmSync(path.join(home, entry), { recursive: true, force: true });
    }

    const settings = { ...(projection?.settings ?? {}), autoMemoryEnabled: false };
    const settingsPath = path.join(home, "settings.json");
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

    const servers = bridgeEntry ? { tachyon_bridge: bridgeEntry } : {};
    const args = this.materializeMcpConfig(agent, { inherit: "none" }, adapter, home, servers);
    return {
      home,
      env: { CLAUDE_CONFIG_DIR: home },
      args: ["--setting-sources", "user", "--settings", settingsPath, ...args],
    };
  }

  private materializeCanonicalClaudeBootstrap(home: string, cwd?: string): void {
    const cfg: Record<string, unknown> = {};
    try {
      const realCfg = JSON.parse(fs.readFileSync(this.realClaudeJson, "utf8")) as Record<string, unknown>;
      if (realCfg && typeof realCfg === "object" && !Array.isArray(realCfg)) {
        for (const key of ONBOARDING_SEED_KEYS) if (key in realCfg) cfg[key] = realCfg[key];
      }
    } catch {
      // Credentials are seeded separately; exact folder trust must not depend on ambient metadata.
    }
    cfg.hasCompletedOnboarding = true;
    const trustedProjects = [...new Set([
      path.resolve(this.workspaceRoot),
      path.resolve(cwd ?? this.workspaceRoot),
    ])].sort();
    cfg.projects = Object.fromEntries(
      trustedProjects.map((project) => [project, { hasTrustDialogAccepted: true }]),
    );
    fs.writeFileSync(path.join(home, ".claude.json"), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
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
    if (adapter.runtime === "grok") {
      const configPath = path.join(this.grokHome(home), h.mcp.fileName);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, this.buildGrokHarnessConfig(def, bridgeEntry), "utf8");
      return [];
    }
    if (adapter.runtime === "hermes") {
      const configPath = path.join(home, h.mcp.fileName);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, this.buildHermesHarnessConfig(def, bridgeEntry), "utf8");
      return [];
    }
    const configPath = path.join(configRoot, h.mcp.fileName);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, adapter.runtime === "opencode" ? this.buildOpencodeHarnessConfig(def, bridgeEntry) : this.buildCodexHarnessConfig(def, bridgeEntry), "utf8");
    return [];
  }

  private grokHome(home: string): string {
    return path.join(home, ".grok");
  }

  private materializeGrokLifecycleHooks(agent: string, home: string, handoffPath: string, opts: { silentPersistence: boolean }): void {
    const recorder = sessionOwnerRecorderPath(this.workspaceRoot);
    fs.mkdirSync(path.dirname(recorder), { recursive: true });
    atomicWrite(recorder, SESSION_OWNER_RECORDER_SOURCE);
    const pointerPath = handoffPointerPath(this.workspaceRoot);
    atomicWrite(pointerPath, SESSION_HANDOFF_POINTER_SOURCE);
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
    const settings = buildOwnershipSettings(recorder, agent, sessionOwnersFile(this.workspaceRoot), { pointerPath, handoffPath }, persistence);
    const hooksRoot = path.join(this.grokHome(home), "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });
    atomicWrite(path.join(hooksRoot, "session-start.json"), `${JSON.stringify({ hooks: { SessionStart: settings.hooks.SessionStart } }, null, 2)}\n`);
    if (settings.hooks.Stop) {
      atomicWrite(path.join(hooksRoot, "stop.json"), `${JSON.stringify({ hooks: { Stop: settings.hooks.Stop } }, null, 2)}\n`);
    } else {
      fs.rmSync(path.join(hooksRoot, "stop.json"), { force: true });
    }
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

  private buildGrokHarnessConfig(def: HarnessDef, bridgeEntry?: Record<string, unknown>): string {
    let toml = "";
    if (def.inherit === "workspace") {
      try {
        toml = fs.readFileSync(path.join(this.workspaceRoot, ".grok", "config.toml"), "utf8");
      } catch {
        toml = "";
      }
    }
    for (const [name, server] of Object.entries(def.mcp ?? {})) {
      toml = setCodexMcpServer(toml, name, this.renderGrokMcpBlock(name, server));
    }
    if (bridgeEntry) {
      const url = typeof bridgeEntry.url === "string" ? bridgeEntry.url : "";
      const headers = bridgeEntry.headers && typeof bridgeEntry.headers === "object" && !Array.isArray(bridgeEntry.headers) ? (bridgeEntry.headers as Record<string, string>) : {};
      if (url) toml = setCodexMcpServer(toml, "tachyon_bridge", this.renderGrokMcpBlock("tachyon_bridge", { url, headers }));
    }
    return toml.endsWith("\n") || toml.length === 0 ? toml : `${toml}\n`;
  }

  private renderGrokMcpBlock(name: string, server: { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }): string {
    const lines = [`[mcp_servers.${tomlKey(name)}]`];
    if (server.url) {
      lines.push(`url = ${tomlString(server.url)}`);
      const headers = Object.entries(server.headers ?? {});
      if (headers.length > 0) lines.push(`headers = { ${headers.map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(", ")} }`);
    } else {
      lines.push(`command = ${tomlString(server.command ?? "")}`);
      if ((server.args ?? []).length > 0) lines.push(`args = [${(server.args ?? []).map(tomlString).join(", ")}]`);
      const env = Object.entries(server.env ?? {});
      if (env.length > 0) lines.push(`env = { ${env.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(", ")} }`);
    }
    return `${lines.join("\n")}\n`;
  }

  /** Seed private Hermes home config.yaml from the real home (model/provider), without Bridge yet. */
  private seedHermesConfigFromReal(home: string): void {
    const target = path.join(home, "config.yaml");
    const realCfg = path.join(this.realHermesHome, "config.yaml");
    try {
      if (!fs.existsSync(target) && fs.existsSync(realCfg)) {
        fs.copyFileSync(realCfg, target);
      }
    } catch {
      /* best-effort — materializeMcpConfig may still write Bridge-only */
    }
    // Symlink .env when present so API-key providers keep working under HERMES_HOME.
    const envLink = path.join(home, ".env");
    const envTarget = path.join(this.realHermesHome, ".env");
    if (fs.existsSync(envTarget)) {
      try {
        fs.unlinkSync(envLink);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      try {
        fs.symlinkSync(envTarget, envLink);
      } catch {
        /* ignore */
      }
    }
  }

  private buildHermesHarnessConfig(def: HarnessDef, bridgeEntry?: Record<string, unknown>): string {
    let base = "";
    const tryRead = (p: string): string => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return "";
      }
    };
    const withoutMcpServers = (text: string): string => {
      try {
        const parsed = text.trim() ? parseYaml(text) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
        const doc = { ...(parsed as Record<string, unknown>) };
        delete doc.mcp_servers;
        return stringifyYaml(doc);
      } catch {
        return "";
      }
    };
    const realBase = withoutMcpServers(tryRead(path.join(this.realHermesHome, "config.yaml")));
    if (def.inherit === "workspace") {
      base = tryRead(path.join(this.workspaceRoot, ".hermes", "config.yaml")) || realBase;
    } else {
      base = realBase;
    }
    let yaml = base;
    for (const [name, server] of Object.entries(def.mcp ?? {})) {
      if (!server.command) continue;
      try {
        const doc = (yaml.trim() ? parseYaml(yaml) : {}) as Record<string, unknown>;
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
        const mcp =
          doc.mcp_servers && typeof doc.mcp_servers === "object" && !Array.isArray(doc.mcp_servers)
            ? { ...(doc.mcp_servers as Record<string, unknown>) }
            : {};
        mcp[name] = {
          command: server.command,
          ...(server.args?.length ? { args: server.args } : {}),
          ...(server.env ? { env: server.env } : {}),
          enabled: true,
        };
        doc.mcp_servers = mcp;
        yaml = stringifyYaml(doc);
      } catch {
        /* keep prior yaml */
      }
    }
    if (bridgeEntry) {
      const url = typeof bridgeEntry.url === "string" ? bridgeEntry.url : "";
      const headers =
        bridgeEntry.headers && typeof bridgeEntry.headers === "object" && !Array.isArray(bridgeEntry.headers)
          ? (bridgeEntry.headers as Record<string, string>)
          : {};
      if (url) yaml = setHermesMcpServer(yaml, "tachyon_bridge", { url, headers, enabled: true });
    }
    return yaml.endsWith("\n") || yaml.length === 0 ? yaml : `${yaml}\n`;
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

  /**
   * t-843576 — materialize a private `GROK_HOME` for a NON-harness grok agent and return its path
   * (injected into the spawn env as `GROK_HOME`). Writes `$home/config.toml` with a Bridge-only
   * `[mcp_servers.tachyon_bridge]` block (`url` + `headers.Authorization = "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}"`
   * — token stays an env ref, no secret on disk) and symlinks `auth.json` → the real authenticated
   * Grok home (fail-closed when the real credential is absent, same as the harness path). Never
   * mutates the user's real `~/.grok/config.toml`. Rewritten on every (re)spawn.
   */
  /**
   * Harvest private Grok auth files across the workspace into `~/.grok/auth.json` and re-symlink
   * every private home. Call on stop/kill as well as materialize so a token refresh during a session
   * is not stranded in one agent home until the next spawn of *that* agent.
   */
  reconcileGrokAuthFromWorkspace(): { promoted: boolean; relinked: number } {
    this.lastGrokHarvestMs = Date.now();
    return reconcileWorkspaceGrokAuth(this.workspaceRoot, this.realGrokHome);
  }

  /**
   * t-6c8437 — harvest while a Grok agent is still running.
   * OIDC refresh replaces the private auth symlink mid-session; waiting for stop/kill left
   * `~/.grok/auth.json` expired and sibling / Dev Host agents on the login wall.
   * No-op when no private regular auth exists or when called inside the throttle window.
   */
  maybeHarvestGrokAuthFromWorkspace(nowMs: number = Date.now()): { promoted: boolean; relinked: number } | null {
    // Only throttle forward in time (tests may inject small clocks; materialize stamps wall-clock).
    const elapsed = nowMs - this.lastGrokHarvestMs;
    if (elapsed >= 0 && elapsed < HarnessManager.GROK_HARVEST_MIN_INTERVAL_MS) return null;
    if (!privateGrokAuthNeedsHarvest(this.workspaceRoot)) return null;
    return this.reconcileGrokAuthFromWorkspace();
  }

  materializeBridgeMcpGrok(
    agent: string,
    bridgeEntry: Record<string, unknown>,
    cwd?: string,
    options: { exactTrust?: boolean } = {},
  ): string {
    const home = bridgeGrokHome(this.workspaceRoot, agent);
    fs.mkdirSync(home, { recursive: true });

    const authLink = path.join(home, "auth.json");
    const authTarget = path.join(this.realGrokHome, "auth.json");
    // Workspace-wide harvest first: multi-agent OIDC refresh leaves *different* keys in each
    // private home; promoting only this agent can re-symlink it to a revoked sibling token.
    this.reconcileGrokAuthFromWorkspace();
    if (!fs.existsSync(authTarget)) {
      throw new HarnessUnavailableError(
        agent,
        `no credentials at ${authTarget} — run grok login first (a redirected GROK_HOME starts logged out)`,
      );
    }
    // Ensure *this* home is linked even if it was just created (reconcile skips missing auth paths).
    ensureAuthSymlink(authLink, authTarget);
    // t-303f2b — never hand the agent a GROK_HOME that looks seeded but cannot read credentials
    // (dangling/unreadable symlink → interactive "Approve in your browser" instead of a hard spawn error).
    assertReadableGrokAuth(agent, home, authTarget);

    const url = typeof bridgeEntry.url === "string" ? bridgeEntry.url : "";
    const headers =
      bridgeEntry.headers && typeof bridgeEntry.headers === "object" && !Array.isArray(bridgeEntry.headers)
        ? (bridgeEntry.headers as Record<string, string>)
        : {};
    let toml = "";
    if (url) {
      toml = setCodexMcpServer(toml, "tachyon_bridge", this.renderGrokMcpBlock("tachyon_bridge", { url, headers }));
    }
    const configPath = path.join(home, "config.toml");
    fs.writeFileSync(configPath, toml.endsWith("\n") || toml.length === 0 ? toml : `${toml}\n`, "utf8");
    // Pre-trust workspace + effective spawn cwd so the folder-trust dialog never blocks managed Grok.
    seedGrokTrustedFolders(
      home,
      [this.workspaceRoot, ...(cwd ? [cwd] : [])],
      undefined,
      undefined,
      options.exactTrust ? "replace" : "merge",
    );
    return home;
  }

  /**
   * Materialize a private `HERMES_HOME` for a NON-harness hermes agent and return its path
   * (injected as `HERMES_HOME`). Writes `$home/config.yaml` with Bridge `mcp_servers.tachyon_bridge`
   * (`Authorization: Bearer ${TACH...N}`), symlinks `auth.json` when OAuth credentials exist, and
   * symlinks `.env` when API-key credentials exist.
   * Never mutates the user's real `~/.hermes/config.yaml`. Rewritten on every (re)spawn.
   */
  materializeBridgeMcpHermes(agent: string, bridgeEntry: Record<string, unknown>): string {
    const home = bridgeHermesHome(this.workspaceRoot, agent);
    fs.mkdirSync(home, { recursive: true });

    const authLink = path.join(home, "auth.json");
    const authTarget = path.join(this.realHermesHome, "auth.json");
    promoteNewerPrivateAuth(authLink, authTarget);
    if (fs.existsSync(authTarget)) {
      ensureAuthSymlink(authLink, authTarget);
      assertReadableHermesAuth(agent, home, authTarget);
    } else {
      // No OAuth credential is valid for API-key providers. Remove a broken/invalid private auth file
      // so Hermes can fall through to `.env` or process environment authentication.
      fs.rmSync(authLink, { force: true });
    }

    this.seedHermesConfigFromReal(home);

    const url = typeof bridgeEntry.url === "string" ? bridgeEntry.url : "";
    const headers =
      bridgeEntry.headers && typeof bridgeEntry.headers === "object" && !Array.isArray(bridgeEntry.headers)
        ? (bridgeEntry.headers as Record<string, string>)
        : {};
    const configPath = path.join(home, "config.yaml");
    let existing = "";
    try {
      existing = fs.readFileSync(configPath, "utf8");
    } catch {
      try {
        existing = fs.readFileSync(path.join(this.realHermesHome, "config.yaml"), "utf8");
      } catch {
        existing = "";
      }
    }
    let yaml = existing;
    if (url) yaml = setHermesMcpServer(yaml, "tachyon_bridge", { url, headers, enabled: true });
    fs.writeFileSync(configPath, yaml.endsWith("\n") || yaml.length === 0 ? yaml : `${yaml}\n`, "utf8");
    return home;
  }

  /** Remove the agent's Bridge-only MCP artifacts (claude file + opencode file + grok/hermes homes; GC, best-effort). */
  removeBridgeMcp(agent: string): void {
    fs.rmSync(bridgeMcpPath(this.workspaceRoot, agent), { force: true });
    fs.rmSync(bridgeOpencodeMcpPath(this.workspaceRoot, agent), { force: true });
    fs.rmSync(bridgeGrokHome(this.workspaceRoot, agent), { recursive: true, force: true });
    fs.rmSync(bridgeHermesHome(this.workspaceRoot, agent), { recursive: true, force: true });
  }

  /**
   * spec 243 — write the per-spawn `--settings` file whose `SessionStart` hook records session ownership,
   * and (idempotently) the standalone recorder it invokes. Returns the settings-file path to append via
   * `--settings`. Works for ANY claude agent (harness or not) and never mutates `~/.claude` or the repo's
   * `.claude/` — `--settings` is an additive command-line layer, so the agent's other hooks still run.
   * Rewritten on every (re)spawn (cheap; keeps the baked-in agent id + paths fresh after a rename/move).
   */
  materializeOwnershipSettings(
    agent: string,
    handoffPath?: string,
    opts: {
      silentPersistence?: boolean;
      skipDangerousModePermissionPrompt?: boolean;
      statusLine?: { type: "command"; command: string; padding?: number };
    } = {},
  ): string {
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
      statusLine: opts.statusLine,
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
