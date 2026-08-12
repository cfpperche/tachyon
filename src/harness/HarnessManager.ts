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
import { GROK_PROJECTED_KEY_ORDER } from "../config/grokNativeConfigProjection.js";
import { withGrokProjectSkillsIgnored } from "../config/grokSkillIsolation.js";
import type { ResolvedAgentCapabilityProjection } from "../config/agentProfileResolver.js";
import type { CapturedCapabilitySource } from "../config/agentCapabilitySource.js";
import { GROK_CANONICAL_MEMORY_POLICY, grokMemoryArgs, grokMemoryEnv } from "../runtime/adapters/grokMemory.js";
import { authRequiredFromHarness, type AuthRequiredEvidence } from "../runtime/authRequired.js";
import type { ResumeAdapter } from "../resume/adapters.js";
import {
  buildCodexSessionStartHookConfig,
  buildOwnershipSettings,
  continuityPointerPath,
  persistenceHookFailureFile,
  handoffPointerPath,
  persistenceStopFile,
  persistenceStopRecorderPath,
  runtimeStatusPublisherPath,
  sessionOwnerRecorderPath,
  sessionOwnersFile,
  spawnSettingsPath,
  PERSISTENCE_STOP_RECORDER_SOURCE,
  RUNTIME_STATUS_PUBLISHER_SOURCE,
  SESSION_CONTINUITY_POINTER_SOURCE,
  SESSION_HANDOFF_POINTER_SOURCE,
  SESSION_OWNER_RECORDER_SOURCE,
  type OwnershipHookGroup,
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

/**
 * t-171cb2 — drop every `[projects…]` table from a Codex config.toml so ambient trust from a
 * copied `~/.codex/config.toml` cannot leak into a private home. Table headers only (measured
 * shape); body lines until the next table or EOF are removed with the header.
 */
function stripCodexProjectsTables(toml: string): string {
  if (toml.length === 0) return "";
  const lines = toml.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\[projects[\.\]]/.test(lines[i]!)) {
      i++;
      while (i < lines.length && !/^\s*\[/.test(lines[i]!)) i++;
      continue;
    }
    out.push(lines[i]!);
    i++;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
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

/** Rank fields for comparing Grok/Hermes/Claude credential candidates (t-2b0a08 / t-6c8437 / t-9598cc). */
export interface AuthCredentialRank {
  mtimeMs: number;
  createTimeMs: number;
  /** Latest access expiry across entries; 0 if none. */
  expiresAtMs: number;
  /**
   * Access token still within `expires_at` (or no expiry field → treat as valid).
   * Expired host auth must lose to a non-expired private refresh even when mtimes confuse us.
   */
  accessValid: boolean;
  /**
   * t-9598cc — latest REFRESH-token expiry across entries; 0 if none. Claude states this
   * (`refreshTokenExpiresAt`); Grok/Hermes do not, so absence is not evidence of anything.
   */
  refreshExpiresAtMs: number;
  /**
   * Refresh token still usable (or no refresh-expiry field → treat as usable). This is what separates
   * "the access token lapsed and the runtime will silently renew it" from "the session is genuinely
   * dead and only a human `/login` can fix it" — a distinction Tachyon could not previously make for
   * Claude, so a merely-lapsed access token and an unprojected home looked identical.
   */
  refreshValid: boolean;
}

/**
 * Grok (and Hermes) write `auth.json` via create+rename under a redirected home, which **replaces**
 * a symlink with a regular file. OIDC refresh tokens are typically single-use / rotate: each private
 * home can end up with a *different* live key, and only the newest is valid server-side.
 * Ranking: non-expired access preferred, then OIDC `create_time`, then mtime (t-6c8437).
 */
/**
 * An instant stated either as an ISO string (Grok/Hermes `expires_at`, `create_time`) or as epoch
 * milliseconds (Claude `expiresAt`, `refreshTokenExpiresAt`). t-9598cc: reading only the ISO form
 * meant every Claude credential parsed as "no expiry stated", which ranks as permanently valid — so
 * an expired credential with a newer mtime beat a live one, and nothing could tell a lapsed session
 * from a home that was never projected.
 */
function credentialInstantMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

export function authCredentialRank(file: string, nowMs: number = Date.now()): AuthCredentialRank {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return { mtimeMs: 0, createTimeMs: 0, expiresAtMs: 0, accessValid: false, refreshExpiresAtMs: 0, refreshValid: false };
  }
  let createTimeMs = 0;
  let expiresAtMs = 0;
  let sawExpires = false;
  let refreshExpiresAtMs = 0;
  let sawRefreshExpires = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        const ct = credentialInstantMs(entry.create_time);
        if (ct !== undefined && ct > createTimeMs) createTimeMs = ct;
        // `expires_at` (Grok/Hermes, ISO) and `expiresAt` (Claude, epoch ms) mean the same thing.
        for (const key of ["expires_at", "expiresAt"] as const) {
          const ms = credentialInstantMs(entry[key]);
          if (ms === undefined) continue;
          sawExpires = true;
          if (ms > expiresAtMs) expiresAtMs = ms;
        }
        for (const key of ["refresh_token_expires_at", "refreshTokenExpiresAt"] as const) {
          const ms = credentialInstantMs(entry[key]);
          if (ms === undefined) continue;
          sawRefreshExpires = true;
          if (ms > refreshExpiresAtMs) refreshExpiresAtMs = ms;
        }
      }
    }
  } catch {
    /* rank by mtime only */
  }
  // No expiry stated (legacy test fixtures, Grok entries) → do not punish; stated past expiry loses.
  const accessValid = !sawExpires || expiresAtMs > nowMs;
  const refreshValid = !sawRefreshExpires || refreshExpiresAtMs > nowMs;
  return { mtimeMs, createTimeMs, expiresAtMs, accessValid, refreshExpiresAtMs, refreshValid };
}

/** Loses to every readable candidate — the seed for a "best so far" scan. */
export const WORST_AUTH_RANK: AuthCredentialRank = {
  mtimeMs: 0,
  createTimeMs: 0,
  expiresAtMs: 0,
  accessValid: false,
  refreshExpiresAtMs: 0,
  refreshValid: false,
};

export function authRankBetter(a: AuthCredentialRank, b: AuthCredentialRank): boolean {
  if (a.accessValid !== b.accessValid) return a.accessValid;
  // A credential whose refresh window has closed cannot renew itself; it loses to one that can.
  // Runtimes that state no refresh expiry rank equal here, so this never reorders Grok/Hermes.
  if (a.refreshValid !== b.refreshValid) return a.refreshValid;
  if (a.createTimeMs !== b.createTimeMs) return a.createTimeMs > b.createTimeMs;
  return a.mtimeMs > b.mtimeMs;
}

/**
 * True when any workspace private Grok home has replaced the auth symlink with a regular file
 * (OIDC refresh in-session). Cheap signal to run harvest without waiting for stop/kill (t-6c8437).
 */
export function privateGrokAuthNeedsHarvest(workspaceRoot: string, realGrokHome?: string): boolean {
  // t-de73e0 — private credentials are COPIES now, so "is a regular file" is true of every home and
  // would ask for a harvest on every tick. What actually needs harvesting is a private credential
  // that outranks the shared one, which is the same question `promoteNewerPrivateAuth` answers.
  const realAuth = realGrokHome ? path.join(realGrokHome, "auth.json") : undefined;
  const realRank = realAuth && fs.existsSync(realAuth) ? authCredentialRank(realAuth) : WORST_AUTH_RANK;
  for (const home of listWorkspaceGrokPrivateHomes(workspaceRoot)) {
    const privateAuth = path.join(home, "auth.json");
    try {
      const st = fs.lstatSync(privateAuth);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (!isReadableJsonObjectFile(privateAuth)) continue;
      if (authRankBetter(authCredentialRank(privateAuth), realRank)) return true;
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

/**
 * t-de73e0 — seed a private credential as a COPY, never as a pointer at the person's own file.
 *
 * The symlink model assumed the runtime only READS the credential it is given. That assumption is no
 * longer safe to hold, and the honest statement of why is narrower than the incident's title.
 *
 * What is ESTABLISHED: this machine's real `~/.grok/auth.json` existed, redirected private homes
 * carrying a symlink to it were in use, and afterwards the real file was gone with `auth.json.lock`
 * left beside it — a lock the runtime writes next to the file it is about to touch, so something
 * resolved the link and operated on the real path. Every private home pointed at that one file, so
 * one agent's loss was everyone's, and no recoverable copy remained.
 *
 * What is NOT established, deliberately recorded here so nobody reads this comment as more than it
 * is: the trigger. Four reproductions against a disposable target failed to destroy it — a headless
 * refusal, an interrupted device-code flow, an expired credential in the documented `sign-in` shape,
 * and `grok inspect` under the same symlink pattern. Both agents who ran probes that day have since
 * withdrawn certainty about their own contribution. A cause outside the symlink path is not excluded.
 *
 * Which is exactly why the fix isolates instead of predicting. A copy does not need the trigger to be
 * known: it removes the class in which any of them could reach the person's credential.
 *
 * A copy makes the destructive case unreachable rather than unlikely: whatever the runtime does to
 * the private file — rewrite, truncate, unlink, replace under a lock — it is doing it to a file that
 * belongs to that agent. The shared credential is reached only by Tachyon's own harvest, which
 * promotes a FRESHER private credential back (`promoteNewerPrivateAuth`), so an in-session refresh
 * still converges instead of being stranded.
 *
 * The private copy is never overwritten by a staler real one: that would throw away a token the agent
 * just refreshed, which is the failure t-2b0a08 and t-6c8437 exist to prevent.
 */
export function ensureAuthCopy(privatePath: string, realAuth: string): void {
  fs.mkdirSync(path.dirname(privatePath), { recursive: true });
  let privateStat: fs.Stats | undefined;
  try {
    privateStat = fs.lstatSync(privatePath);
  } catch (e) {
    if (!isErrnoCode(e, "ENOENT")) throw e;
  }
  // A regular private credential that is at least as good as the real one is the agent's own, and
  // fresher or equal — leave it alone.
  if (privateStat?.isFile() && !privateStat.isSymbolicLink() && isReadableJsonObjectFile(privatePath)) {
    if (!authRankBetter(authCredentialRank(realAuth), authCredentialRank(privatePath))) return;
  }
  if (privateStat) {
    // Includes the legacy symlink this function replaces. Unlink FIRST: copying onto a symlink would
    // write through it, which is the entire defect.
    fs.unlinkSync(privatePath);
  }
  fs.copyFileSync(realAuth, privatePath);
  fs.chmodSync(privatePath, 0o600);
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
      if (ent.isDirectory() && ent.name.endsWith(BRIDGE_RUNTIME_HOME_SUFFIXES.grok)) {
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
  let bestRank: AuthCredentialRank = WORST_AUTH_RANK;

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
    ensureAuthCopy(privateAuth, realAuth);
    relinked += 1;
  }
  return { promoted, relinked };
}

/** The credential file a private `CLAUDE_CONFIG_DIR` authenticates from. */
export const CLAUDE_CREDENTIALS_FILE = ".credentials.json";

/**
 * t-9598cc — how a private Claude home currently stands relative to the authority home.
 *
 * Claude Code writes `.credentials.json` by create+rename under `CLAUDE_CONFIG_DIR`, which REPLACES
 * Tachyon's symlink with a regular file the moment it refreshes its OAuth token. This is the exact
 * mechanism already measured for Grok (t-2b0a08, t-6c8437) and it was never handled for Claude, so a
 * private home silently detached from `~/.claude/.credentials.json` and stayed detached: a later
 * global `/login` refreshed the authority and the private snapshot kept serving a dead token.
 *
 * Measured 2026-07-27: `.tachyon/harness/claude-opus5/.credentials.json` was a regular file whose
 * contents differed from the authority's, while sibling homes were still symlinks.
 *
 * The two axes are reported separately on purpose. "Where does this home read from?" and "is that
 * credential any good?" have different recoveries, and collapsing them is what made a merely-lapsed
 * access token, a never-projected home, and a genuinely dead session all present as one opaque
 * `runtime_auth_rejected`.
 */
export type ClaudeCredentialProjection =
  /** Symlink to this authority's credential — the healthy state. */
  | "linked"
  /** A regular file: the runtime refreshed in-session and replaced the link. Harvestable. */
  | "detached"
  /** Nothing at this path — a fresh or cleaned home that was never projected. */
  | "absent"
  /** A symlink somewhere else — a deliberately separate account/profile. Never reconciled. */
  | "foreign";

export type ClaudeCredentialHealth =
  /** Access token still inside its stated window. */
  | "valid"
  /** Access lapsed but the refresh token is still live — the runtime renews this itself. */
  | "refreshable"
  /** Both windows closed: only a human `claude /login` recovers this. */
  | "expired"
  /** Present but not a readable JSON object. */
  | "unreadable"
  /** No credential to judge. */
  | "absent";

export interface ClaudeCredentialState {
  projection: ClaudeCredentialProjection;
  health: ClaudeCredentialHealth;
  /** Resolved target when `projection` is a symlink; the file itself when it is a regular file. */
  source?: string;
}

function claudeCredentialHealth(file: string, nowMs: number): ClaudeCredentialHealth {
  if (!fs.existsSync(file)) return "absent";
  if (!isReadableJsonObjectFile(file)) return "unreadable";
  const rank = authCredentialRank(file, nowMs);
  if (rank.accessValid) return "valid";
  return rank.refreshValid ? "refreshable" : "expired";
}

/**
 * Classify one private Claude home against the authority credential. Pure observation — never
 * repairs, so a caller can report before it acts (and so the diagnosis is table-testable).
 */
export function claudeCredentialState(
  privateHome: string,
  realAuth: string,
  nowMs: number = Date.now(),
): ClaudeCredentialState {
  const privateAuth = path.join(privateHome, CLAUDE_CREDENTIALS_FILE);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(privateAuth);
  } catch {
    return { projection: "absent", health: claudeCredentialHealth(realAuth, nowMs) };
  }
  if (st.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.readlinkSync(privateAuth);
    } catch {
      return { projection: "absent", health: "absent" };
    }
    const resolved = path.isAbsolute(target) ? target : path.resolve(privateHome, target);
    return {
      projection: resolved === realAuth ? "linked" : "foreign",
      health: claudeCredentialHealth(resolved, nowMs),
      source: resolved,
    };
  }
  return { projection: "detached", health: claudeCredentialHealth(privateAuth, nowMs), source: privateAuth };
}

/** The non-secret account marker a home is bound to (`.claude.json` → `oauthAccount.accountUuid`). */
export function claudeHomeAccountId(claudeJsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8")) as Record<string, unknown>;
    const account = parsed.oauthAccount;
    if (account && typeof account === "object" && !Array.isArray(account)) {
      const uuid = (account as { accountUuid?: unknown }).accountUuid;
      if (typeof uuid === "string" && uuid.trim()) return uuid.trim();
    }
    const userId = parsed.userID;
    return typeof userId === "string" && userId.trim() ? userId.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Private Claude homes under this workspace: `<harness>/<agent>` directories that actually carry a
 * Claude projection. Presence of `.credentials.json` or `.claude.json` is the marker — a codex or
 * grok agent's home sits in the same root and must not be swept in. Pure path scan.
 */
export function listWorkspaceClaudePrivateHomes(workspaceRoot: string): string[] {
  const homes: string[] = [];
  const root = harnessRoot(workspaceRoot);
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const home = path.join(root, ent.name);
      const claudeish = [CLAUDE_CREDENTIALS_FILE, ".claude.json"].some((file) => {
        try {
          fs.lstatSync(path.join(home, file));
          return true;
        } catch {
          return false;
        }
      });
      if (claudeish) homes.push(home);
    }
  } catch (e) {
    if (!isErrnoCode(e, "ENOENT")) throw e;
  }
  return homes;
}

/**
 * Cheap signal that at least one private Claude home is out of step with the authority — either it
 * detached (in-session refresh) or its link points at a credential that is gone. Lets the agent-list
 * tick skip the reconcile entirely in the common converged case.
 */
export function privateClaudeAuthNeedsReconcile(
  workspaceRoot: string,
  realClaudeHome: string,
  nowMs: number = Date.now(),
): boolean {
  const realAuth = path.join(realClaudeHome, CLAUDE_CREDENTIALS_FILE);
  for (const home of listWorkspaceClaudePrivateHomes(workspaceRoot)) {
    const state = claudeCredentialState(home, realAuth, nowMs);
    if (state.projection === "detached") return true;
    if (state.projection === "linked" && state.health === "absent") return true;
  }
  return false;
}

export interface ClaudeAuthReconcileResult {
  promoted: boolean;
  relinked: number;
  /** Homes left untouched because they belong to another account/profile. */
  skipped: string[];
}

/**
 * Workspace-wide Claude auth reconcile — the Grok fix (t-2b0a08 / t-6c8437) applied to the runtime
 * that has the same failure mode:
 *  1. harvest every private regular `.credentials.json` (in-session refresh replaced the symlink);
 *  2. promote the freshest onto the authority, so a refresh is never destroyed by re-linking;
 *  3. re-symlink EVERY eligible private home to that one authority file, so a global `/login`
 *     reaches homes that are not being materialized right now.
 *
 * Step 3 is the one the measured bug needed: re-linking only the home being spawned left every other
 * agent's stale snapshot alive, which is how a refreshed global credential failed to reach an
 * existing harness at all.
 *
 * Account isolation: a home whose credential is a symlink to a DIFFERENT target, or whose
 * `.claude.json` names a different `oauthAccount`, is a deliberately separate profile. It is neither
 * harvested from nor relinked — sharing one workspace must never merge two accounts' sessions.
 */
export function reconcileWorkspaceClaudeAuth(
  workspaceRoot: string,
  realClaudeHome: string,
  realClaudeJson: string,
  nowMs: number = Date.now(),
): ClaudeAuthReconcileResult {
  const realAuth = path.join(realClaudeHome, CLAUDE_CREDENTIALS_FILE);
  const authorityAccount = claudeHomeAccountId(realClaudeJson);
  const skipped: string[] = [];
  const eligible: string[] = [];

  for (const home of listWorkspaceClaudePrivateHomes(workspaceRoot)) {
    const homeAccount = claudeHomeAccountId(path.join(home, ".claude.json"));
    const foreignAccount = !!authorityAccount && !!homeAccount && homeAccount !== authorityAccount;
    const foreignLink = claudeCredentialState(home, realAuth, nowMs).projection === "foreign";
    if (foreignAccount || foreignLink) skipped.push(home);
    else eligible.push(home);
  }

  let promoted = false;
  let bestPrivate: string | undefined;
  let bestRank = WORST_AUTH_RANK;
  for (const home of eligible) {
    const privateAuth = path.join(home, CLAUDE_CREDENTIALS_FILE);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(privateAuth);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    if (!isReadableJsonObjectFile(privateAuth)) continue;
    const rank = authCredentialRank(privateAuth, nowMs);
    if (!bestPrivate || authRankBetter(rank, bestRank)) {
      bestPrivate = privateAuth;
      bestRank = rank;
    }
  }

  if (bestPrivate) {
    if (fs.existsSync(realAuth)) {
      if (authRankBetter(bestRank, authCredentialRank(realAuth, nowMs))) {
        fs.mkdirSync(path.dirname(realAuth), { recursive: true });
        fs.copyFileSync(bestPrivate, realAuth);
        fs.chmodSync(realAuth, 0o600);
        promoted = true;
      }
    } else {
      fs.mkdirSync(path.dirname(realAuth), { recursive: true });
      fs.copyFileSync(bestPrivate, realAuth);
      fs.chmodSync(realAuth, 0o600);
      promoted = true;
    }
  }

  if (!fs.existsSync(realAuth)) return { promoted, relinked: 0, skipped };

  let relinked = 0;
  for (const home of eligible) {
    const privateAuth = path.join(home, CLAUDE_CREDENTIALS_FILE);
    // Only converge homes that already have (or had) a credential path; never seed an unrelated dir.
    try {
      fs.lstatSync(privateAuth);
    } catch {
      continue;
    }
    ensureAuthSymlink(privateAuth, realAuth);
    relinked += 1;
  }
  return { promoted, relinked, skipped };
}

/**
 * Fail a Claude launch at the harness boundary — before any tmux session exists — when the projected
 * credential cannot authenticate. Parity with `assertReadableGrokAuth` (t-303f2b).
 *
 * Why here and not at launch readiness: `materializeRuntimeHarness` runs before the pane is created,
 * so throwing here leaves nothing half-started. The measured cascade went the other way — the agent
 * launched, `runtime_auth_rejected` arrived from readiness, and the compensation that followed had a
 * live session, a prepared worktree and a materialized home to unwind.
 *
 * `refreshable` is deliberately NOT a failure: a lapsed access token with a live refresh token is the
 * ordinary state of a credential between renewals, and the runtime renews it itself.
 */
export function assertUsableClaudeAuth(agent: string, privateHome: string, realAuth: string, nowMs: number = Date.now()): void {
  const state = claudeCredentialState(privateHome, realAuth, nowMs);
  if (state.projection === "absent") {
    throw credentialRefusal(
      agent,
      "claude",
      `no Claude credential projected into ${privateHome} (authority ${realAuth}) — a redirected CLAUDE_CONFIG_DIR starts logged out; run claude /login, then restart this agent`,
    );
  }
  if (state.health === "unreadable") {
    throw credentialRefusal(
      agent,
      "claude",
      `Claude credential for '${agent}' is not readable JSON at ${state.source ?? privateHome} — run claude /login to rewrite it, then restart this agent`,
    );
  }
  if (state.health === "expired") {
    throw credentialRefusal(
      agent,
      "claude",
      `Claude session for '${agent}' is expired at ${state.source ?? privateHome}: both the access and refresh windows have closed, so this is a real re-login and not a stale projection — run claude /login, then restart this agent`,
    );
  }
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

/**
 * t-7bc276 — the runtimes whose private home under `bridge-mcp` is a DIRECTORY, keyed by the suffix
 * that names it. Claude and opencode put a FILE there instead (`<agent>.json`, `<agent>.opencode.json`),
 * which is exactly why the ownerless sweep never saw these: both enumerators feeding `removeBridgeMcp`
 * are blind to a directory (`list()` reads `.tachyon/harness/`, `listBridgeMcp()` filters `isFile()`),
 * and a NON-harness grok/hermes agent creates neither. Measured 2026-08-07: 35 dismissed `*.grok`
 * homes had reached 2.2 GB, ~12.9 MB apiece the moment each agent took its first turn.
 *
 * This constant is the single source for BOTH halves — the path a home is materialized at and the
 * scan that later finds it — so a third private-home runtime cannot be added on one side only. That
 * one-sided addition IS the defect: `bridgeGrokHome` arrived with t-843576 and never joined a sweep.
 */
export const BRIDGE_RUNTIME_HOME_SUFFIXES = { grok: ".grok", hermes: ".hermes" } as const;

export type BridgeRuntimeHomeRuntime = keyof typeof BRIDGE_RUNTIME_HOME_SUFFIXES;

/** One private runtime home materialized under `bridge-mcp`, decoded back to its (agent, runtime). */
export interface BridgeRuntimeHome {
  agent: string;
  runtime: BridgeRuntimeHomeRuntime;
  path: string;
}

/** The private home path for one (agent, runtime) pair — the only place the suffix is applied. */
export function bridgeRuntimeHome(workspaceRoot: string, agent: string, runtime: BridgeRuntimeHomeRuntime): string {
  return path.join(bridgeMcpRoot(workspaceRoot), `${agent}${BRIDGE_RUNTIME_HOME_SUFFIXES[runtime]}`);
}

/** Every runtime that owns a private `bridge-mcp` home — the enumeration every sweep must walk. */
export function bridgeRuntimeHomeRuntimes(): BridgeRuntimeHomeRuntime[] {
  return Object.keys(BRIDGE_RUNTIME_HOME_SUFFIXES) as BridgeRuntimeHomeRuntime[];
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
  return bridgeRuntimeHome(workspaceRoot, agent, "grok");
}

/**
 * t-076a28 — restore the operator's git identity inside a private home that is ALSO the agent's
 * `HOME`.
 *
 * SDD 456 co-binds `HOME` to the private `GROK_HOME` for canonical Grok so the runtime cannot
 * discover `$HOME/.claude/settings.json`. But `HOME` is not only where Grok looks for config — it is
 * the `HOME` of everything the agent shells out to. Measured on the co-bound home: `git commit`
 * fails outright with *"Author identity unknown"*, because `~/.gitconfig` is no longer on any path
 * git consults. A canonical Grok agent therefore could not commit at all.
 *
 * The fix is an include, not a copy: the private `.gitconfig` points at the operator's real global
 * config, so identity (and their aliases, signing config, everything else) is read live from the one
 * file they own. Nothing is duplicated and nothing drifts.
 *
 * Deliberately narrow. This restores git's *global config discovery* only; it does not re-expose the
 * rest of the real `HOME`, and specifically NOT `~/.ssh` — see the Grok row in
 * `docs/runtimes/parity.md` for why SSH is a declared limitation rather than a seeded credential.
 *
 * Measured: adding this file keeps `grok inspect --json` at `permissions.sources: []` / `loaded: 0`,
 * so the isolation it exists to protect is untouched. A `[include]` whose target is missing is
 * silently ignored by git, but this writes nothing when there is no real config to include, so a
 * private home never carries a dangling pointer.
 */
export function seedPrivateHomeGitIdentity(
  home: string,
  homeDir: string = os.homedir(),
  exists: (p: string) => boolean = (p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  },
): string | undefined {
  const real = path.join(homeDir, ".gitconfig");
  // Never point a private home at ITSELF: that would be a self-include loop if home === homeDir.
  if (path.resolve(home) === path.resolve(homeDir) || !exists(real)) return undefined;
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, ".gitconfig");
  fs.writeFileSync(file, `# Tachyon-managed (t-076a28): the agent's HOME is private, so git would\n# otherwise find no global config. Read the operator's real one live.\n[include]\n\tpath = ${real}\n`, "utf8");
  return file;
}

/**
 * t-26f508 — the closed isolation block every canonical Grok private home carries, regardless of
 * which optional families a profile authored.
 *
 * Redirecting `GROK_HOME` does not stop foreign-harness discovery: measured on 0.2.112, a project
 * `.claude/skills/*` is still found and listed. Pinning every `[compat.*]` cell to `false` is what
 * turns that discovery off — the same measurement shows those skills flip to
 * `compatibilityStatus: "disabled"`. Memory is pinned here as well so the private home states the
 * policy in configuration, next to the `GROK_MEMORY=0` env pin that `grokMemoryEnv` carries; t-0e88f3
 * measured the env var, not this key, as the control that actually decides, so this is a declaration
 * beside the control rather than a second control.
 *
 * These are unconditional for the same reason Claude forces `autoMemoryEnabled: false`: they are the
 * canonical posture, not a preference, and no measured opt-in exists. A profile's `tooling`/`memory`
 * families record the refusal so a reader sees it in the profile instead of inferring it from here.
 */
const GROK_CANONICAL_ISOLATION_TOML = [
  "[memory]",
  "enabled = false",
  "",
  "[compat.cursor]",
  "skills = false",
  "rules = false",
  "agents = false",
  "mcps = false",
  "hooks = false",
  "sessions = false",
  "",
  "[compat.claude]",
  "skills = false",
  "rules = false",
  "agents = false",
  "mcps = false",
  "hooks = false",
  "sessions = false",
  "",
  "[compat.codex]",
  "sessions = false",
].join("\n");

/**
 * Render the canonical Grok `config.toml` body: the profile-selected scalars grouped back into their
 * tables, then the unconditional isolation block. Deterministic by construction — keys are emitted in
 * {@link GROK_PROJECTED_KEY_ORDER}, so the same profile produces the same bytes on fresh, restart and
 * resume, which is what makes "regenerated equivalently" checkable rather than asserted.
 */
export function renderGrokCanonicalConfig(
  agent: string,
  projection: ResolvedAgentNativeConfigProjection,
): string {
  if (projection.adapter !== "grok") {
    throw new HarnessUnavailableError(agent, `native configuration targets '${projection.adapter}', not 'grok'`);
  }
  const values = projection.toml ?? {};
  const tables = new Map<string, string[]>();
  for (const key of GROK_PROJECTED_KEY_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const separator = key.lastIndexOf(".");
    const table = key.slice(0, separator);
    const leaf = key.slice(separator + 1);
    const lines = tables.get(table) ?? [];
    lines.push(`${tomlKey(leaf)} = ${tomlValue(values[key])}`);
    tables.set(table, lines);
  }
  const blocks = [...tables].map(([table, lines]) => [`[${table}]`, ...lines].join("\n"));
  return `${[...blocks, GROK_CANONICAL_ISOLATION_TOML].join("\n\n")}\n`;
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
  return bridgeRuntimeHome(workspaceRoot, agent, "hermes");
}

/**
 * Every private runtime home under `bridge-mcp`, live or orphaned. Pure path scan — creates nothing.
 * The directory NAME is the only index these homes have once the ledger row is gone, so decoding it
 * back to (agent, runtime) is what makes an orphan nameable instead of merely large.
 */
export function listBridgeRuntimeHomes(workspaceRoot: string): BridgeRuntimeHome[] {
  const root = bridgeMcpRoot(workspaceRoot);
  const homes: BridgeRuntimeHome[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (!isErrnoCode(e, "ENOENT")) throw e;
    return homes;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const runtime of bridgeRuntimeHomeRuntimes()) {
      const suffix = BRIDGE_RUNTIME_HOME_SUFFIXES[runtime];
      // `.grok` alone is not `<agent>.grok`: an empty agent name would decode to "" and then let a
      // keep-set miss match it, so a suffix-only directory is left to the human rather than claimed.
      if (!entry.name.endsWith(suffix) || entry.name.length === suffix.length) continue;
      homes.push({ agent: entry.name.slice(0, -suffix.length), runtime, path: path.join(root, entry.name) });
      break;
    }
  }
  return homes.sort((a, b) => a.path.localeCompare(b.path));
}

/** What `retireBridgeRuntimeHomes` did to one private home, and what it weighed at that moment. */
export interface BridgeRuntimeHomeRetirement extends BridgeRuntimeHome {
  bytes: number;
  files: number;
  removed: boolean;
  /** cwd of the live process that held the home, when removal was withheld for that reason. */
  heldBy?: string;
}

/**
 * Bytes on disk (apparent size) and file count of a subtree. Best-effort: unreadable entries are skipped.
 *
 * `maxFiles` bounds the walk because the caller on the startup path is measuring exactly the tree that
 * motivated this — the real one held 41,948 files, and a report is not worth 42k stat calls before the
 * workspace opens. A bounded answer says so through `truncated` so the reader knows it is a floor.
 */
export function measureDirUsage(dir: string, maxFiles = Number.POSITIVE_INFINITY): { bytes: number; files: number; truncated: boolean } {
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const walk = (current: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (files >= maxFiles) {
        truncated = true;
        return;
      }
      files += 1;
      try {
        bytes += fs.lstatSync(child).size;
      } catch {
        /* vanished mid-walk — the count still reports it existed */
      }
    }
  };
  walk(dir);
  return { bytes, files, truncated };
}

/**
 * The cwd of a live process sitting inside one of `roots`, or undefined when every root is quiesced.
 * `/proc/<pid>/cwd` is the only evidence available that a runtime still owns a private home; an
 * absent `/proc` yields NO evidence and reads as quiesced, which is the pre-existing behaviour of
 * the credential retirement this was extracted from.
 */
function liveProcessCwdInside(roots: readonly string[], procRoot: string): string | undefined {
  try {
    for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name) || Number(entry.name) === process.pid) continue;
      let cwd: string;
      try { cwd = fs.realpathSync(path.join(procRoot, entry.name, "cwd")); } catch { continue; }
      if (roots.some((root) => cwd === root || cwd.startsWith(`${root}${path.sep}`))) return cwd;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
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

/**
 * t-2656d7 — the environment a NATIVE login must run under: the runtime's REAL config home.
 *
 * The login writes the AUTHORITY that every private home is a projection of, so it has to be pointed
 * at the same directory `materializeRuntimeHarness` reads its credential from — otherwise the human
 * completes a login and the next launch is refused by the same message, which is a worse outcome
 * than no button at all.
 *
 * Setting these explicitly also neutralises an inherited redirect. Tachyon's own process can be
 * running with `GROK_HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR` pointing at a private home; sending a
 * login there would write a credential into a Tachyon-managed directory that
 * `defaultRealGrokHome`/`defaultRealHermesHome` already refuse to treat as an auth source
 * (`t-303f2b`). The resolvers below carry that refusal, so the login inherits it.
 *
 * A runtime with no measured login command (`RUNTIME_LOGIN`) never reaches here.
 */
export function realRuntimeAuthHomeEnv(
  runtime: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Record<string, string> {
  switch (runtime) {
    case "claude":
      return { CLAUDE_CONFIG_DIR: realConfigHome(env, homeDir) };
    case "codex":
      return { CODEX_HOME: defaultRealCodexHome(env, homeDir) };
    case "grok":
      return { GROK_HOME: defaultRealGrokHome(env, homeDir) };
    default:
      return {};
  }
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
    throw credentialRefusal(
      agent,
      "hermes",
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
  /**
   * t-2656d7 — present ONLY when the refusal is "this runtime is not authenticated", so a caller can
   * tell that condition from the other dozen reasons a harness fails to materialize (an unsafe
   * projection path, a missing secret ref, a malformed capability snapshot). Those are Tachyon's
   * problems; this one is the human's, and it is the only one with a recovery a button can run.
   *
   * The class carried nothing but a string until now, which is why `extension.ts` could only turn a
   * launch refusal into `notify(err.message, "error")` — and an action-less notify is the branch
   * that routes to `setStatusBarMessage` (`workspace/notify.ts:41`), where the recovery instruction
   * was clipped by the width of one status-bar cell and erased eight seconds later.
   */
  constructor(readonly agent: string, reason: string, readonly authRequired?: AuthRequiredEvidence) {
    super(`isolated harness for '${agent}': ${reason}`);
    this.name = "HarnessUnavailableError";
  }
}

/**
 * t-2656d7 — build a credential refusal that carries its own recovery.
 *
 * Every credential throw site in this file goes through here so the evidence is attached at the
 * throw rather than reconstructed downstream by matching on the message text — the reconstruction
 * this repository has paid for before, and the reason `HarnessUnavailableError` has zero handlers
 * outside this file today.
 */
function credentialRefusal(agent: string, runtime: string, reason: string): HarnessUnavailableError {
  return new HarnessUnavailableError(agent, reason, authRequiredFromHarness(runtime, reason));
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
    throw credentialRefusal(
      agent,
      "grok",
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
  /** t-9598cc — same throttle for the Claude reconcile. */
  private lastClaudeHarvestMs = 0;
  private static readonly CLAUDE_HARVEST_MIN_INTERVAL_MS = 5_000;

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
    nativeConfig?: ResolvedAgentNativeConfigProjection,
  ): MaterializedHarness {
    if (projection.adapter !== adapter.runtime) {
      throw new HarnessUnavailableError(agent, `capability snapshot targets '${projection.adapter}', not '${adapter.runtime}'`);
    }
    if (adapter.runtime === "pi") return this.materializePiProfileHome(agent, projection, cwd);
    if (adapter.runtime === "claude") {
      return this.materializeCanonicalClaudeProfileHome(agent, adapter, { capabilities: projection }, cwd, bridgeEntry);
    }
    if (adapter.runtime === "grok") {
      const home = this.materializeBridgeMcpGrok(agent, bridgeEntry ?? {}, cwd, {
        ...(nativeConfig ? { nativeConfig } : {}),
      });
      this.replaceCapturedSkillTree(agent, home, projection);
      this.writeProfileCapabilityManifest(agent, home, projection);
      return { home, env: { GROK_HOME: home, HOME: home }, args: [] };
    }
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

  private replaceCapturedSkillTree(agent: string, root: string, projection: ResolvedAgentCapabilityProjection): void {
    const target = path.join(root, "skills");
    const stage = path.join(root, `.skills-staging-${randomUUID()}`);
    const prior = path.join(root, `.skills-prior-${randomUUID()}`);
    try {
      const stat = fs.lstatSync(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new HarnessUnavailableError(agent, `profile skill projection root must be a real directory: ${root}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }
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

  /**
   * t-987347 — EMPTY IS A SELECTION, and this is what executes it.
   *
   * Zero selection produces no capability projection at all (`agentProfileResolver`,
   * `deliveredAnything`), so `def.profileCapabilities` is undefined and `Workspace.materializeHarness`
   * routes a REVOKED profile to a different door than a selected one. Every `if (capabilities)` guard
   * therefore describes the one case a revocation never reaches: measured 2026-08-10, the grok profile
   * lost its `capabilities:` block, its private home was regenerated the next day, and all three
   * granted skill trees were still sitting in `$GROK_HOME/skills` with their 07/08 mtimes — reachable,
   * because `~/.grok/skills` is a documented Grok discovery root that the config's `[skills] ignore`
   * covers only for PROJECT roots.
   *
   * So the purge is unconditional and runs BEFORE the decision to re-materialize, exactly as Claude's
   * sweep has always done. `entries` names what THIS runtime's grant path writes into the private home
   * and nothing else — `apagar demais é pior que apagar de menos`: codex projects its skill tree into
   * the launch project's `.agents/skills`, shared with the plugin installer, and pi's resource
   * generations are content-addressed, inert without the `--skill` args a revoked profile no longer
   * receives, and may still be open in a live process. Neither is swept from here.
   */
  private purgeProfileCapabilityProjection(home: string, entries: readonly string[] = []): void {
    for (const entry of [...entries, PROFILE_CAPABILITY_ROOT]) {
      fs.rmSync(path.join(home, entry), { recursive: true, force: true });
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
        skills: projection.skills.map((entry) => ({
          name: entry.name,
          sha256: entry.source.sha256,
          origins: projection.skillOrigins?.[entry.name] ?? [{ kind: "profile", agent }],
        })),
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
    // t-987347 — the one door every Pi path passes through, so a profile that lost its selection
    // cannot keep an attestation that says it still has one. The resource generations under
    // `.tachyon-resources` are deliberately left where they are: they are content-addressed, a
    // revoked profile no longer receives the explicit `--skill` args that are Pi's only way to reach
    // them, and a still-live process may have them open (see materializePiHomeOnly).
    this.purgeProfileCapabilityProjection(home);
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
    lifecycle?: { handoffPath?: string; silentPersistence?: boolean; projectedHooks?: Record<string, OwnershipHookGroup[]> },
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
    const args = this.materializeMcpConfig(agent, def, adapter, home, mergedServers, bridge, cwd);
    if (adapter.runtime === "grok") {
      this.materializeGrokLifecycleHooks(agent, this.grokHome(home), lifecycle?.handoffPath ?? path.join(this.workspaceRoot, ".tachyon", "HANDOFF.md"), {
        // Grok is not an eligible silent-persistence runtime. Keep the capability explicit for the
        // measured harness fixture, but never opt a product caller in merely by omitting the option.
        silentPersistence: lifecycle?.silentPersistence ?? false,
        ...(lifecycle?.projectedHooks ? { projectedHooks: lifecycle.projectedHooks } : {}),
      });
      this.materializeSkills(agent, def, home);
      // t-0e88f3 — pin the disabled memory policy in BOTH channels, for different reasons. The env pin
      // carries the guarantee: measurement refuted the flag's documented precedence over GROK_MEMORY,
      // so an ambient GROK_MEMORY=1 is only overridden by naming the variable ourselves. The flag stays
      // because it is free and documented, not because it is load-bearing. Ordered so the memory env
      // cannot be overwritten by a secret of the same name — a `GROK_MEMORY` in the secret map would
      // otherwise silently re-enable memory on the canonical path.
      return {
        home,
        env: { [h.configHomeEnv]: this.grokHome(home), ...secretEnv, ...grokMemoryEnv(GROK_CANONICAL_MEMORY_POLICY) },
        args: [...args, ...grokMemoryArgs(GROK_CANONICAL_MEMORY_POLICY)],
      };
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

    // t-fc1df8 — this is the one private-home door both Claude routes cross. A grantless Temporary
    // child is auto-isolated to transcript and never reaches materializeCanonicalClaudeProfileHome,
    // so keeping the sweep in that capability-aware branch left an old, name-reused `skills` tree
    // live under a profile that grants nothing. Purge before either route decides what to rebuild;
    // the selected route immediately re-materializes its current captured skills below.
    if (adapter.runtime === "claude") {
      this.purgeProfileCapabilityProjection(home, ["skills"]);
    }

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
          throw credentialRefusal(
            agent,
            "opencode",
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
    // t-9598cc — Claude has the same in-session-refresh detachment as Grok. Harvest BEFORE the
    // ensureAuthSymlink below, which would otherwise overwrite a fresher private credential with a
    // staler authority one, and converge every sibling home so a global /login actually reaches them.
    if (adapter.runtime === "claude") {
      this.reconcileClaudeAuthFromWorkspace();
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
        throw credentialRefusal(agent, adapter.runtime, `no credentials at ${authTarget} — run ${login} first (a redirected config home starts logged out)`);
      }
      // t-de73e0 / t-1e67b4 — Grok and Hermes can write the credential they are handed, so each
      // private home gets its own copy. Claude and Codex retain their measured symlink posture until
      // an equivalent write-through path is confirmed for them.
      if (adapter.runtime === "grok" || adapter.runtime === "hermes") ensureAuthCopy(authLink, authTarget);
      else ensureAuthSymlink(authLink, authTarget);
    }

    // t-9598cc — parity with grok/hermes (t-303f2b): prove the projected credential can actually
    // authenticate before the home is handed back, so an expired session fails here with a named
    // recovery instead of surfacing as runtime_auth_rejected after a pane and a worktree exist.
    if (adapter.runtime === "claude") {
      assertUsableClaudeAuth(agent, home, path.join(authSourceHome, CLAUDE_CREDENTIALS_FILE));
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
   *
   * t-171cb2 — `exactTrustCwd` is the delegated-Codex class door for directory trust. Measured on
   * codex-cli 0.146.0: trust is exact-path only (not prefix-inherited) and is NOT governable via
   * argv `-c`, so the only channel is this private `config.toml` write. When set, ambient
   * `[projects.*]` tables copied from the human's `~/.codex` are stripped and replaced with
   * workspace + the exact spawn cwd — nothing inherited, top-level/declared callers omit the option.
   */
  materializeHomeOnly(
    agent: string,
    adapter: ResumeAdapter,
    cwd?: string,
    options: { inheritNativeConfig?: boolean; exactTrustCwd?: string } = {},
  ): MaterializedHarness {
    const home = this.materializeHome(agent, adapter, cwd);
    const h = adapter.harness;
    if (!h) throw new Error(`runtime '${adapter.runtime}' does not support an isolated config home`);
    if (adapter.runtime === "codex") {
      if (options.inheritNativeConfig === false) fs.rmSync(path.join(home, "config.toml"), { force: true });
      else this.seedCodexHomeOnlyConfig(home);
      if (options.exactTrustCwd !== undefined) {
        this.writeCodexExactProjectTrust(home, options.exactTrustCwd);
      }
    }
    // t-c46c35 — `isolate: transcript` is still a canonical launch, so it carries the same memory pin;
    // t-0e88f3 added the env half, which is the half that holds.
    if (adapter.runtime === "grok") {
      return {
        home,
        env: { [h.configHomeEnv]: this.grokHome(home), ...grokMemoryEnv(GROK_CANONICAL_MEMORY_POLICY) },
        args: grokMemoryArgs(GROK_CANONICAL_MEMORY_POLICY),
      };
    }
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
    // t-94d49a — REFUSE rather than replace a directory this projection does not own. The skill tree
    // below goes to `<cwd>/.agents/skills`, and with the agent's worktree OFF `cwd` IS the workspace
    // root — where that directory belongs to the plugin installer (`src/plugins/engine.ts` codex
    // `skillsRel`, recorded per install in `src/plugins/lockfile.ts` so uninstall removes exactly
    // what it created). `replaceCapturedSkillTree` swaps the WHOLE directory, so the launch would
    // delete the workspace's entire plugin roster.
    //
    // Launching anyway without projecting was the other candidate outcome and measurement rejects
    // it. On codex-cli 0.146.1 (`codex debug prompt-input`, temp fixture): every
    // `<cwd>/.agents/skills/<name>` is model-visible regardless of `CODEX_HOME`; `[skills] paths`
    // adds no private root; and the one suppression that works, `[[skills.config]] name/enabled`,
    // is keyed by NAME — which is the t-f842f0 collision itself, since a granted skill and a plugin
    // skill share the name. So that launch would hand the agent the ENTIRE ambient roster under a
    // profile that granted none of it — the inheritance t-62f599 withdrew the worktree skill
    // projection to stop. Composition with a per-entry owner is t-f842f0; refusing is what this
    // measurement supports today.
    if (capabilities && path.resolve(cwd ?? this.workspaceRoot) === path.resolve(this.workspaceRoot)) {
      const collision = path.join(path.resolve(this.workspaceRoot), ".agents", "skills");
      throw new HarnessUnavailableError(
        agent,
        `its Codex skill grants would replace ${collision}, which holds this workspace's plugin installs — `
        + "give this agent a worktree so it launches outside the workspace root, or remove its skill grants",
      );
    }
    const home = this.materializeHome(agent, adapter, cwd);
    // t-987347 — unconditional, because the guard this replaced (`if (capabilities)`) named the one
    // case a revocation never reaches. Codex's skill tree is NOT swept with it: it is projected into
    // the launch project's `.agents/skills`, a directory the plugin installer also owns, so removing
    // it here would delete plugin installs belonging to every other agent in the workspace.
    this.purgeProfileCapabilityProjection(home);
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
      // Codex discovers user-authored skills from the launch project's `.agents/skills`, not
      // CODEX_HOME. This tree is still an exact grant projection: it is rebuilt solely from the
      // resolved, digest-pinned capability snapshot and never copied from the ambient workspace.
      // The one root it must never own — the workspace's own, shared with the plugin installer —
      // was refused above (t-94d49a), so this replacement only ever lands in the agent's worktree.
      this.replaceCapturedSkillTree(agent, path.join(cwd ?? this.workspaceRoot, ".agents"), capabilities);
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
    return this.materializeCanonicalClaudeProfileHome(
      agent,
      adapter,
      { ...(projection ? { nativeConfig: projection } : {}) },
      cwd,
      bridgeEntry,
    );
  }

  /**
   * Materialize Claude native settings and captured capabilities as one manifest-committed private
   * generation. The manifest is removed first and published last, so partial writes are never
   * attestable as a complete capability projection.
   */
  materializeCanonicalClaudeProfileHome(
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
    if (adapter.runtime !== "claude") throw new Error(`runtime '${adapter.runtime}' is not Claude`);
    if (nativeConfig && nativeConfig.adapter !== "claude") {
      throw new HarnessUnavailableError(agent, `native configuration targets '${nativeConfig.adapter}', not 'claude'`);
    }
    if (capabilities && capabilities.adapter !== "claude") {
      throw new HarnessUnavailableError(agent, `capability snapshot targets '${capabilities.adapter}', not 'claude'`);
    }
    const harness = adapter.harness;
    if (!harness || harness.mcp.mode !== "flag") {
      throw new HarnessUnavailableError(agent, "Claude capability projection requires flag-scoped MCP support");
    }
    const home = this.materializeHome(agent, adapter, cwd);
    this.materializeCanonicalClaudeBootstrap(home, cwd);

    for (const entry of ["CLAUDE.md", "settings.local.json", "mcp.json", "plugins", "agents", "commands"]) {
      fs.rmSync(path.join(home, entry), { recursive: true, force: true });
    }

    const settings = {
      ...(nativeConfig?.settings ?? {}),
      ...(capabilities && Object.keys(capabilities.hooks).length > 0 ? { hooks: capabilities.hooks } : {}),
      autoMemoryEnabled: false,
    };
    const settingsPath = path.join(home, "settings.json");
    atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);

    const servers: Record<string, unknown> = {
      ...(capabilities?.mcp ?? {}),
      ...(bridgeEntry ? { tachyon_bridge: bridgeEntry } : {}),
    };
    const mcpPath = path.join(home, harness.mcp.fileName);
    atomicWrite(mcpPath, `${JSON.stringify(buildMcpConfig(servers), null, 2)}\n`, 0o600);
    if (capabilities) {
      this.replaceCapturedSkillTree(agent, home, capabilities);
      this.writeProfileCapabilityManifest(agent, home, capabilities);
    }
    const secretEnv = capabilities
      ? this.resolveMcpSecretEnv(agent, { inherit: "none", mcp: capabilities.mcp })
      : {};
    const selectorArgs: string[] = [];
    if (nativeConfig?.selectors.model) selectorArgs.push("--model", nativeConfig.selectors.model);
    if (nativeConfig?.selectors.reasoningEffort) {
      selectorArgs.push("--effort", nativeConfig.selectors.reasoningEffort);
    }
    return {
      home,
      env: { CLAUDE_CONFIG_DIR: home, ...secretEnv },
      args: [
        "--setting-sources", "user",
        "--settings", settingsPath,
        ...selectorArgs,
        ...harness.mcp.args(mcpPath),
      ],
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

  private materializeMcpConfig(
    _agent: string,
    def: HarnessDef,
    adapter: ResumeAdapter,
    home: string,
    servers: Record<string, unknown>,
    bridgeEntry?: Record<string, unknown>,
    cwd?: string,
  ): string[] {
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
      fs.writeFileSync(configPath, this.buildGrokHarnessConfig(def, bridgeEntry, cwd), "utf8");
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

  /**
   * t-836be3 — write the workspace's projected `enforcement` gate hooks into a private `$GROK_HOME/hooks/`.
   *
   * Its own file, never merged into `session-start.json`/`stop.json`: those two are Tachyon's lifecycle
   * channel, and Grok merges every discovered source, so a separate file is both sufficient and the only
   * shape in which a reclassified plugin can be REMOVED without rewriting ownership. Deleting on empty is
   * the load-bearing half — a stale `projected.json` would keep gating a session whose policy no longer
   * says so, and `$GROK_HOME` outlives a single spawn.
   */
  private writeGrokProjectedHooks(hooksRoot: string, projectedHooks?: Record<string, OwnershipHookGroup[]>): void {
    const file = path.join(hooksRoot, "projected.json");
    // SessionStart/Stop are skipped for the same reason as on the Claude/Codex channels (buildOwnershipSettings
    // and renderCodexProjectedHookConfig both skip them): a policy change must not be able to displace or
    // duplicate the ownership hooks by installing a gate.
    const hooks = Object.fromEntries(
      Object.entries(projectedHooks ?? {})
        .filter(([event, groups]) => event !== "SessionStart" && event !== "Stop" && groups.length > 0)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    if (Object.keys(hooks).length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(hooksRoot, { recursive: true });
    atomicWrite(file, `${JSON.stringify({ hooks }, null, 2)}\n`);
  }

  private materializeGrokLifecycleHooks(
    agent: string,
    grokHome: string,
    handoffPath: string | undefined,
    opts: { silentPersistence: boolean; projectedHooks?: Record<string, OwnershipHookGroup[]> },
  ): void {
    const recorder = sessionOwnerRecorderPath(this.workspaceRoot);
    fs.mkdirSync(path.dirname(recorder), { recursive: true });
    atomicWrite(recorder, SESSION_OWNER_RECORDER_SOURCE);
    const runtimeStatusPublisher = runtimeStatusPublisherPath(this.workspaceRoot);
    atomicWrite(runtimeStatusPublisher, RUNTIME_STATUS_PUBLISHER_SOURCE);
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
    const settings = buildOwnershipSettings(recorder, agent, sessionOwnersFile(this.workspaceRoot), pointer, persistence, {}, { publisherPath: runtimeStatusPublisher, runtime: "grok" });
    const hooksRoot = path.join(grokHome, "hooks");
    fs.mkdirSync(hooksRoot, { recursive: true });
    atomicWrite(path.join(hooksRoot, "session-start.json"), `${JSON.stringify({ hooks: { SessionStart: settings.hooks.SessionStart } }, null, 2)}\n`);
    if (settings.hooks.Stop) {
      atomicWrite(path.join(hooksRoot, "stop.json"), `${JSON.stringify({ hooks: { Stop: settings.hooks.Stop } }, null, 2)}\n`);
    } else {
      fs.rmSync(path.join(hooksRoot, "stop.json"), { force: true });
    }
    this.writeGrokProjectedHooks(hooksRoot, opts.projectedHooks);
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

  private buildGrokHarnessConfig(def: HarnessDef, bridgeEntry?: Record<string, unknown>, cwd?: string): string {
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
    if (def.inherit !== "workspace") {
      toml = withGrokProjectSkillsIgnored(toml, this.workspaceRoot, cwd);
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
   * t-171cb2 — write exact-path `[projects."<path>"] trust_level = "trusted"` for the workspace root
   * and the effective spawn cwd. The cwd is the worktree path resolved before materialize on every
   * spawn/restart/resume door, so the path written here is the path Codex will ask about.
   * Replaces any ambient projects tables already in the private config (see stripCodexProjectsTables).
   */
  private writeCodexExactProjectTrust(home: string, cwd: string): void {
    const configPath = path.join(home, "config.toml");
    let content = "";
    try {
      content = fs.readFileSync(configPath, "utf8");
    } catch {
      /* absent is fine — we write only the trust blocks */
    }
    content = stripCodexProjectsTables(content);
    const trustedProjects = [...new Set([
      path.resolve(this.workspaceRoot),
      path.resolve(cwd),
    ])].sort();
    const blocks = trustedProjects
      .map((project) => `[projects.${tomlString(project)}]\ntrust_level = "trusted"`)
      .join("\n\n");
    const body = content.trimEnd();
    atomicWrite(configPath, body.length > 0 ? `${body}\n\n${blocks}\n` : `${blocks}\n`);
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
   * End-of-life security cleanup: the dead agent keeps no authority. This removes the CREDENTIAL
   * only and fails loud when it cannot, because authority left behind is the worse outcome; the
   * bytes around it are `retireBridgeRuntimeHomes`' problem and it is allowed to give up quietly.
   *
   * t-7bc276 — an older comment here read "runtime caches are deliberately retained: a forget has no
   * reliable way to prove that every cache writer has quiesced". The proof was already in this
   * function: `liveProcessCwdInside` is exactly that evidence, and it now serves both callers.
   */
  retireCredentials(agent: string, test?: { procRoot?: string; beforeDelete?: (credential: string) => void }): void {
    const roots = [
      this.home(agent),
      ...bridgeRuntimeHomeRuntimes().map((runtime) => bridgeRuntimeHome(this.workspaceRoot, agent, runtime)),
    ];
    const occupied = liveProcessCwdInside(roots, test?.procRoot ?? "/proc");
    if (occupied) throw new Error(`credential cleanup refused occupied runtime home: ${occupied}`);
    for (const root of roots) {
      for (const relative of ["auth.json", path.join("data", "opencode", "auth.json")]) {
        const credential = path.join(root, relative);
        let before: fs.Stats;
        try { before = fs.lstatSync(credential); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        // Never follow a surprising directory/special file. Symlinks are safe to unlink: only the
        // private pointer is removed, not the user's canonical credential it may target.
        if (!before.isFile() && !before.isSymbolicLink()) {
          throw new Error(`credential cleanup refused dirty path: ${credential}`);
        }
        test?.beforeDelete?.(credential);
        const after = fs.lstatSync(credential);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new Error(`credential cleanup refused dirty path: ${credential}`);
        }
        fs.unlinkSync(credential);
      }
    }
  }

  /** Every private `bridge-mcp` runtime home in this workspace, live or orphaned (read-only). */
  listBridgeRuntimeHomes(): BridgeRuntimeHome[] {
    return listBridgeRuntimeHomes(this.workspaceRoot);
  }

  /**
   * t-7bc276 — end-of-life removal of the private runtime homes under `bridge-mcp`. Measured before
   * removal so the outcome can SAY what disappeared: a grok home costs ~12.9 MB the moment its first
   * turn runs (`bundled/` alone is 12.84 MB and is identical in every home), and nothing reads any of
   * it once the agent is gone — the two survivors that still touch the directory read the dirent name
   * (`detectRuntimes`) and an `auth.json` this call's sibling already deleted.
   *
   * Removal is best-effort ON PURPOSE. A dismissal must not fail over garbage collection, and a
   * directory a live process is still sitting in must not be pulled out from under it, so an occupied
   * home is REPORTED and left standing rather than removed or thrown over. It stays nameable through
   * `listBridgeRuntimeHomes`.
   */
  retireBridgeRuntimeHomes(
    agent: string,
    opts: { procRoot?: string; onOutcome?: (outcome: BridgeRuntimeHomeRetirement) => void } = {},
  ): BridgeRuntimeHomeRetirement[] {
    const outcomes: BridgeRuntimeHomeRetirement[] = [];
    // t-652153 — Claude and OpenCode materialize regular files in the same namespace rather than
    // runtime-home directories. They have no resumable/cache payload and cannot be a process cwd, so
    // end-of-life removes them directly. This must live on the canonical retirement door: relying on
    // the next-start orphan sweep left the file behind after dismiss/Forget and let a same-name spawn
    // inherit an artifact belonging to the previous identity until it happened to be overwritten.
    for (const file of [bridgeMcpPath(this.workspaceRoot, agent), bridgeOpencodeMcpPath(this.workspaceRoot, agent)]) {
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort, like the directory retirement below */ }
    }
    for (const runtime of bridgeRuntimeHomeRuntimes()) {
      const home = bridgeRuntimeHome(this.workspaceRoot, agent, runtime);
      try {
        if (!fs.statSync(home).isDirectory()) continue;
      } catch {
        continue; // absent — nothing to retire, and never report a home that was never materialized
      }
      const usage = measureDirUsage(home);
      const heldBy = liveProcessCwdInside([home], opts.procRoot ?? "/proc");
      let removed = false;
      if (!heldBy) {
        try {
          removeDirByRenameThenRm(home);
          removed = true;
        } catch {
          /* reported as not removed; the orphan sweep names it again next start */
        }
      }
      const outcome: BridgeRuntimeHomeRetirement = { agent, runtime, path: home, ...usage, removed, heldBy };
      outcomes.push(outcome);
      opts.onOutcome?.(outcome);
    }
    return outcomes;
  }

  /** Names whose private runtime homes still contain credentials. Read-only reconciliation input. */
  credentialHomeNames(): string[] {
    const names = new Set<string>();
    try {
      for (const entry of fs.readdirSync(harnessRoot(this.workspaceRoot), { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch { /* absent root */ }
    // t-7bc276 — the same decoder the end-of-life sweep uses, rather than a second hand-rolled one
    // that spelled the suffix lengths as -5 / -7 and would have to be found again for a third runtime.
    for (const home of listBridgeRuntimeHomes(this.workspaceRoot)) names.add(home.agent);
    return [...names].filter((name) => {
      const roots = [this.home(name), bridgeGrokHome(this.workspaceRoot, name), bridgeHermesHome(this.workspaceRoot, name)];
      return roots.some((root) => ["auth.json", path.join("data", "opencode", "auth.json")].some((rel) => fs.existsSync(path.join(root, rel))));
    }).sort();
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
    if (!privateGrokAuthNeedsHarvest(this.workspaceRoot, this.realGrokHome)) return null;
    return this.reconcileGrokAuthFromWorkspace();
  }

  /**
   * t-9598cc — the Claude counterpart. Harvest every private `.credentials.json` that the runtime
   * detached by refreshing in-session, promote the freshest onto `~/.claude/.credentials.json`, and
   * re-symlink every eligible private home back onto it.
   *
   * Call on materialize AND on agent-list refresh: the measured failure was a home that nobody
   * materialized after the global `/login`, so its stale snapshot outlived the refresh indefinitely.
   */
  reconcileClaudeAuthFromWorkspace(nowMs: number = Date.now()): ClaudeAuthReconcileResult {
    this.lastClaudeHarvestMs = nowMs;
    return reconcileWorkspaceClaudeAuth(this.workspaceRoot, this.realHome, this.realClaudeJson, nowMs);
  }

  /**
   * Throttled reconcile for the agent-list tick, mirroring `maybeHarvestGrokAuthFromWorkspace`.
   * No-op inside the throttle window or when every private home is already converged — so the common
   * case costs one cheap directory scan.
   */
  maybeReconcileClaudeAuthFromWorkspace(nowMs: number = Date.now()): ClaudeAuthReconcileResult | null {
    const elapsed = nowMs - this.lastClaudeHarvestMs;
    if (elapsed >= 0 && elapsed < HarnessManager.CLAUDE_HARVEST_MIN_INTERVAL_MS) return null;
    if (!privateClaudeAuthNeedsReconcile(this.workspaceRoot, this.realHome, nowMs)) return null;
    return this.reconcileClaudeAuthFromWorkspace(nowMs);
  }

  /**
   * t-836be3 — `options.projectedHooks` is the SAME workspace plan the harness path receives, and it is
   * accepted here because this is the `$GROK_HOME` real Grok agents get. Measured 2026-08-02 on 0.56.149:
   * `materializeGrokLifecycleHooks` runs only from `materialize()`, i.e. only for a `harness:`-declared
   * agent, and this workspace's three live Grok homes have no `hooks/` dir at all. Wiring the gate only
   * into the harness path would have shipped a channel no spawnable agent uses.
   *
   * t-53e5f2 — this path also owns Grok's lifecycle materialization. Every real Grok agent receives
   * SessionStart ownership; declared/canonical agents additionally receive the project-handoff pointer.
   * Continuity and Stop stay absent: Grok is not eligible for silent persistence, and enabling those
   * hooks would also change nudge suppression and the persisted silent-hook ledger.
   */
  materializeBridgeMcpGrok(
    agent: string,
    bridgeEntry: Record<string, unknown>,
    cwd?: string,
    options: {
      exactTrust?: boolean;
      nativeConfig?: ResolvedAgentNativeConfigProjection;
      projectedHooks?: Record<string, OwnershipHookGroup[]>;
      lifecycle?: { handoffPath?: string };
    } = {},
  ): string {
    const home = bridgeGrokHome(this.workspaceRoot, agent);
    fs.mkdirSync(home, { recursive: true });
    // t-987347 — this is the door a grok profile with NO selection reaches, and the only one that
    // runs on both paths: `materializeProfileCapabilities` calls it first and re-materializes the
    // selected tree immediately after, so purging here is "rebuild from the current selection"
    // rather than "delete". `skills` joins the sweep because for grok the granted tree lives in this
    // home; nothing else writes it (`materializeSkills` targets the harness home, a different root).
    this.purgeProfileCapabilityProjection(home, ["skills"]);

    const authLink = path.join(home, "auth.json");
    const authTarget = path.join(this.realGrokHome, "auth.json");
    // Workspace-wide harvest first: multi-agent OIDC refresh leaves *different* keys in each
    // private home; promoting only this agent can re-symlink it to a revoked sibling token.
    this.reconcileGrokAuthFromWorkspace();
    if (!fs.existsSync(authTarget)) {
      throw credentialRefusal(
        agent,
        "grok",
        `no credentials at ${authTarget} — run grok login first (a redirected GROK_HOME starts logged out)`,
      );
    }
    // Ensure *this* home has its own copy even if it was just created (reconcile skips missing paths).
    // t-de73e0 — a COPY, never a pointer: a Grok that re-authenticates here must not be able to reach
    // the person's credential.
    ensureAuthCopy(authLink, authTarget);
    // t-303f2b — never hand the agent a GROK_HOME that looks seeded but cannot read credentials
    // (unreadable credential → interactive "Approve in your browser" instead of a hard spawn error).
    assertReadableGrokAuth(agent, home, authTarget);

    const url = typeof bridgeEntry.url === "string" ? bridgeEntry.url : "";
    const headers =
      bridgeEntry.headers && typeof bridgeEntry.headers === "object" && !Array.isArray(bridgeEntry.headers)
        ? (bridgeEntry.headers as Record<string, string>)
        : {};
    // t-26f508 — the canonical projection is rendered FIRST and the Bridge block appended after it,
    // so `setCodexMcpServer` never has to splice a server table into the middle of a scalar table.
    let toml = options.nativeConfig ? renderGrokCanonicalConfig(agent, options.nativeConfig) : "";
    // t-84c678 — redirecting GROK_HOME does not suppress native project discovery. Grok 0.2.118
    // still loaded both `.grok/skills` and `.agents/skills` with every compat cell off. The private
    // config therefore hides the workspace/effective-worktree roots; exact selected bytes, when any,
    // are written to this home's own `skills/` by `materializeProfileCapabilities`.
    toml = withGrokProjectSkillsIgnored(toml, this.workspaceRoot, cwd);
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
    // Global scope (`$GROK_HOME/hooks/*.json`) — always trusted. Ownership reaches Temporary agents;
    // lifecycle.handoffPath distinguishes declared/canonical agents without granting persistence.
    this.materializeGrokLifecycleHooks(agent, home, options.lifecycle?.handoffPath, {
      silentPersistence: false,
      ...(options.projectedHooks ? { projectedHooks: options.projectedHooks } : {}),
    });
    return home;
  }

  /**
   * Materialize a private `HERMES_HOME` for a NON-harness hermes agent and return its path
   * (injected as `HERMES_HOME`). Writes `$home/config.yaml` with Bridge `mcp_servers.tachyon_bridge`
   * (`Authorization: Bearer ${TACH...N}`), copies `auth.json` when OAuth credentials exist, and
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
      // Hermes persists refresh state through its auth store. Keep that write inside this agent's
      // private home; a symlink would route the atomic replacement back to the user's credential.
      ensureAuthCopy(authLink, authTarget);
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
      /** t-09edf2 — the workspace's projected `enforcement` gate hooks for this session. */
      projectedHooks?: Record<string, OwnershipHookGroup[]>;
    } = {},
  ): string {
    const recorder = sessionOwnerRecorderPath(this.workspaceRoot);
    fs.mkdirSync(path.dirname(recorder), { recursive: true });
    // Atomic write (temp + rename): concurrent (re)spawns rewrite the SHARED recorder, and a sibling's
    // SessionStart hook may be running `node <recorder>` at that instant — an in-place writeFileSync could
    // truncate it mid-read and silently drop the ownership row (codex review). renameSync is atomic on the
    // same fs, so a reader sees either the old or new complete file, never a torn one.
    atomicWrite(recorder, SESSION_OWNER_RECORDER_SOURCE);
    const runtimeStatusPublisher = runtimeStatusPublisherPath(this.workspaceRoot);
    atomicWrite(runtimeStatusPublisher, RUNTIME_STATUS_PUBLISHER_SOURCE);
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
      ...(opts.projectedHooks ? { projectedHooks: opts.projectedHooks } : {}),
    }, { publisherPath: runtimeStatusPublisher, runtime: "claude" });
    const file = spawnSettingsPath(this.workspaceRoot, agent);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`); // same race for the per-agent settings on restart/resume
    return file;
  }

  /**
   * spec 303 — Codex has native lifecycle hooks, but no Claude-style `--settings` file layer. Inject
   * session-scoped `-c key=value` overrides instead; Codex merges them with workspace/user hooks.
   */
  materializeCodexSessionStartHookConfig(
    agent: string,
    handoffPath?: string,
    opts: {
      silentPersistence?: boolean;
      /** t-09edf2 — the workspace's projected `enforcement` gate hooks for this session. */
      projectedHooks?: Record<string, OwnershipHookGroup[]>;
    } = {},
  ): string | string[] {
    const recorder = sessionOwnerRecorderPath(this.workspaceRoot);
    fs.mkdirSync(path.dirname(recorder), { recursive: true });
    atomicWrite(recorder, SESSION_OWNER_RECORDER_SOURCE);
    const runtimeStatusPublisher = runtimeStatusPublisherPath(this.workspaceRoot);
    atomicWrite(runtimeStatusPublisher, RUNTIME_STATUS_PUBLISHER_SOURCE);
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
    return buildCodexSessionStartHookConfig(recorder, sessionOwnersFile(this.workspaceRoot), pointer, persistence, opts.projectedHooks, runtimeStatusPublisher);
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
