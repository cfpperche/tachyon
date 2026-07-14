import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeStatusLineCaptureReader, ClaudeStatusLineCaptureV1 } from "./claudeStatusLineSource.js";
import type { ProviderObservationPreferences } from "./preferences.js";

const TRANSPORT_SCHEMA_VERSION = 1 as const;
const TRANSPORT_DIR = "runtime-observability-v1";
const CLAUDE_DIR = "claude-status-line";
const WRAPPER_FILE = "capture-wrapper.cjs";
const RELAY_DIR = "relays";
const CAPTURE_MARKER_FILE = "capture-enabled.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024;
const MAX_MARKER_BYTES = 512;
const MAX_CAPTURE_FILES = 256;
const MAX_DIRECTORY_ENTRIES = MAX_CAPTURE_FILES * 2 + 16;
const DEFAULT_MAX_CAPTURE_AGE_MS = 10 * 60_000;
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const SAFE_SCOPE_KEY = /^ps_[0-9a-f]{16,64}$/u;
const SAFE_CAPTURE_FILE = /^[0-9a-f]{32}\.capture\.json$/u;
const SAFE_RELAY_FILE = /^[0-9a-f]{32}\.relay\.json$/u;
const MAX_STATUS_LINE_COMMAND_BYTES = 4 * 1024;

export interface ClaudeStatusLineSetting {
  type: "command";
  command: string;
  padding?: number;
}

export interface ClaudeStatusLineMaterializeRequest {
  workspaceRoot: string;
  agent: string;
  cwd: string;
  /** Effective CLAUDE_CONFIG_DIR. Omit for Claude's normal `~/.claude` home. */
  configHome?: string;
}

export interface ClaudeStatusLineCaptureTransportOptions {
  homeDir?: string;
  managedSettingsPaths?: readonly string[];
  now?: () => Date;
  maxCaptureAgeMs?: number;
}

interface StoredCaptureV1 {
  schemaVersion: typeof TRANSPORT_SCHEMA_VERSION;
  observedAt: string;
  rate_limits: Record<string, unknown>;
}

interface SettingsReadResult {
  ok: boolean;
  value?: Record<string, unknown>;
}

/**
 * Host transport for Claude's documented token-free status-line telemetry. Raw status-line JSON exists only in the
 * short-lived wrapper process; disk receives a bounded numeric projection of the two documented quota windows.
 */
export class ClaudeStatusLineCaptureTransport {
  private readonly root: string;
  private readonly homeDir: string;
  private readonly managedSettingsPaths: readonly string[];
  private readonly now: () => Date;
  private readonly maxCaptureAgeMs: number;

  constructor(
    globalStoragePath: string,
    private readonly preferences: ProviderObservationPreferences,
    options: ClaudeStatusLineCaptureTransportOptions = {},
  ) {
    this.root = path.join(path.resolve(globalStoragePath), TRANSPORT_DIR, CLAUDE_DIR);
    this.homeDir = path.resolve(options.homeDir ?? os.homedir());
    this.managedSettingsPaths = options.managedSettingsPaths ?? defaultManagedSettingsPaths();
    this.now = options.now ?? (() => new Date());
    this.maxCaptureAgeMs = boundedPositiveInteger(
      options.maxCaptureAgeMs ?? DEFAULT_MAX_CAPTURE_AGE_MS,
      MAX_CAPTURE_AGE_MS,
      "capture lifetime",
    );
    this.reconcileConsent();
  }

  materialize(request: ClaudeStatusLineMaterializeRequest): ClaudeStatusLineSetting | undefined {
    const preference = this.preferences.get("claude");
    if (!preference || !preference.sources.includes("cli") || !SAFE_SCOPE_KEY.test(preference.scope.key)) {
      return undefined;
    }
    const configHome = request.configHome?.trim()
      ? path.resolve(request.cwd, request.configHome)
      : undefined;
    if (!this.isKnownConfigHome(request.workspaceRoot, configHome)) return undefined;
    const prior = resolveEffectiveStatusLine({
      cwd: request.cwd,
      configHome,
      homeDir: this.homeDir,
      managedSettingsPaths: this.managedSettingsPaths,
    });
    if (!prior.ok) return undefined;

    try {
      this.ensureScopeDirectory(preference.scope.key);
      const relayDir = path.join(this.root, RELAY_DIR);
      ensurePrivateDirectory(relayDir);
      const wrapper = path.join(this.root, WRAPPER_FILE);
      const target = crypto.createHash("sha256")
        .update(path.resolve(request.workspaceRoot))
        .update("\0")
        .update(request.agent)
        .update("\0")
        // Keep a running session bound to the command it resolved at spawn time. A later settings edit gets a new
        // relay instead of changing the behavior of an older wrapper invocation in place.
        .update(prior.setting?.command ?? "")
        .digest("hex")
        .slice(0, 32);
      const relayName = `${target}.relay.json`;
      if (!hasRelayCapacity(relayDir, relayName)) return undefined;
      const relay = path.join(relayDir, relayName);
      atomicPrivateWrite(wrapper, CLAUDE_STATUS_LINE_CAPTURE_WRAPPER_SOURCE);
      atomicPrivateWrite(relay, `${JSON.stringify({
        schemaVersion: TRANSPORT_SCHEMA_VERSION,
        priorCommand: prior.setting?.command ?? null,
      })}\n`);
      this.removeInactiveScopeDirectories(preference.scope.key);
      atomicPrivateWrite(path.join(this.root, CAPTURE_MARKER_FILE), `${JSON.stringify({
        schemaVersion: TRANSPORT_SCHEMA_VERSION,
        accountScopeKey: preference.scope.key,
      })}\n`);
      return {
        type: "command",
        command: `node ${shellQuote(wrapper)} ${shellQuote(relay)}`,
        ...(prior.setting?.padding !== undefined ? { padding: prior.setting.padding } : {}),
      };
    } catch {
      // Capture is optional. Unsafe or unwritable transport state must not prevent the original Claude spawn.
      return undefined;
    }
  }

  readonly readCapture: ClaudeStatusLineCaptureReader = async (signal) => {
    if (signal.aborted) throw abortError();
    const preference = this.preferences.get("claude");
    if (!preference || !preference.sources.includes("cli") || !SAFE_SCOPE_KEY.test(preference.scope.key)) return null;
    if (!isPrivateDirectory(this.root)) return null;
    if (readCaptureMarker(path.join(this.root, CAPTURE_MARKER_FILE)) !== preference.scope.key) return null;
    const scopeDir = path.join(this.root, preference.scope.key);
    if (!isPrivateDirectory(scopeDir)) return null;

    let directory: fs.Dir | undefined;
    let newest: ClaudeStatusLineCaptureV1 | null = null;
    let newestMs = -1;
    let entries = 0;
    let captures = 0;
    try {
      directory = fs.opendirSync(scopeDir);
      for (;;) {
        if (signal.aborted) throw abortError();
        const entry = directory.readSync();
        if (!entry) break;
        entries += 1;
        if (entries > MAX_DIRECTORY_ENTRIES) return null;
        if (!SAFE_CAPTURE_FILE.test(entry.name)) continue;
        captures += 1;
        if (captures > MAX_CAPTURE_FILES) return null;
        const capture = readStoredCapture(path.join(scopeDir, entry.name), this.now().getTime(), this.maxCaptureAgeMs);
        if (!capture) continue;
        const observedMs = Date.parse(capture.observedAt);
        if (observedMs <= newestMs) continue;
        newestMs = observedMs;
        newest = {
          observedAt: capture.observedAt,
          json: JSON.stringify({ rate_limits: capture.rate_limits }),
        };
      }
      return newest;
    } catch (error) {
      if (signal.aborted) throw abortError();
      return null;
    } finally {
      try { directory?.closeSync(); } catch { /* best-effort descriptor cleanup */ }
    }
  };

  clearProvider(provider: "codex" | "claude"): void {
    if (provider !== "claude") return;
    if (!isPrivateDirectory(this.root)) return;
    removeRegularFile(path.join(this.root, CAPTURE_MARKER_FILE));
    this.removeInactiveScopeDirectories();
  }

  private ensureScopeDirectory(scopeKey: string): string {
    const transportRoot = path.dirname(this.root);
    ensurePrivateDirectory(transportRoot);
    ensurePrivateDirectory(this.root);
    const scopeDir = path.join(this.root, scopeKey);
    ensurePrivateDirectory(scopeDir);
    return scopeDir;
  }

  private reconcileConsent(): void {
    if (!isPrivateDirectory(this.root)) return;
    const preference = this.preferences.get("claude");
    const expected = preference?.sources.includes("cli") ? preference.scope.key : undefined;
    const marker = readCaptureMarker(path.join(this.root, CAPTURE_MARKER_FILE));
    const active = marker !== undefined && marker === expected ? marker : undefined;
    if (!active) removeRegularFile(path.join(this.root, CAPTURE_MARKER_FILE));
    this.removeInactiveScopeDirectories(active);
  }

  private removeInactiveScopeDirectories(keep?: string): void {
    let entries: string[];
    try {
      const stat = fs.lstatSync(this.root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      entries = fs.readdirSync(this.root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!SAFE_SCOPE_KEY.test(entry) || entry === keep) continue;
      removeScopeDirectory(this.root, entry);
    }
  }

  private isKnownConfigHome(workspaceRoot: string, configHome: string | undefined): boolean {
    if (!configHome) return true;
    const resolved = path.resolve(configHome);
    if (resolved === path.join(this.homeDir, ".claude")) return true;
    const harnessRoot = path.join(path.resolve(workspaceRoot), ".tachyon", "harness");
    if (!resolved.startsWith(`${harnessRoot}${path.sep}`)) return false;
    try {
      const realWorkspaceRoot = fs.realpathSync(path.resolve(workspaceRoot));
      const realHarnessRoot = fs.realpathSync(harnessRoot);
      const realConfigHome = fs.realpathSync(resolved);
      return realHarnessRoot === path.join(realWorkspaceRoot, ".tachyon", "harness")
        && fs.statSync(realHarnessRoot).isDirectory()
        && fs.statSync(realConfigHome).isDirectory()
        && realConfigHome.startsWith(`${realHarnessRoot}${path.sep}`);
    } catch {
      // A missing home or a symlink escaping the workspace-owned harness tree cannot identify the granted account.
      return false;
    }
  }
}

interface ResolveStatusLineOptions {
  cwd: string;
  configHome?: string;
  homeDir: string;
  managedSettingsPaths: readonly string[];
}

export function resolveEffectiveStatusLine(options: ResolveStatusLineOptions):
  | { ok: true; setting?: ClaudeStatusLineSetting }
  | { ok: false } {
  for (const managedPath of options.managedSettingsPaths) {
    const managed = readSettings(managedPath);
    if (!managed.ok) return { ok: false };
    if (managed.value && Object.prototype.hasOwnProperty.call(managed.value, "statusLine")) return { ok: false };
  }

  const configHome = options.configHome?.trim()
    ? path.resolve(options.configHome)
    : path.join(path.resolve(options.homeDir), ".claude");
  const layers = [
    path.join(configHome, "settings.json"),
    path.join(path.resolve(options.cwd), ".claude", "settings.json"),
    path.join(path.resolve(options.cwd), ".claude", "settings.local.json"),
  ];
  let effective: ClaudeStatusLineSetting | undefined;
  for (const file of layers) {
    const layer = readSettings(file);
    if (!layer.ok) return { ok: false };
    if (!layer.value || !Object.prototype.hasOwnProperty.call(layer.value, "statusLine")) continue;
    const setting = parseStatusLineSetting(layer.value.statusLine);
    if (!setting) return { ok: false };
    effective = setting;
  }
  return { ok: true, ...(effective ? { setting: effective } : {}) };
}

function readSettings(file: string): SettingsReadResult {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { ok: true } : { ok: false };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return { ok: false };
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_SETTINGS_BYTES) return { ok: false };
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
    return record(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function parseStatusLineSetting(raw: unknown): ClaudeStatusLineSetting | undefined {
  if (!record(raw) || raw.type !== "command" || typeof raw.command !== "string") return undefined;
  if (raw.command.length === 0
    || raw.command.includes("\0")
    || Buffer.byteLength(raw.command) > MAX_STATUS_LINE_COMMAND_BYTES) return undefined;
  const setting: ClaudeStatusLineSetting = { type: "command", command: raw.command };
  if (raw.padding !== undefined) {
    if (!Number.isSafeInteger(raw.padding) || (raw.padding as number) < 0 || (raw.padding as number) > 10) {
      return undefined;
    }
    setting.padding = raw.padding as number;
  }
  return setting;
}

function readStoredCapture(file: string, nowMs: number, maxAgeMs: number): StoredCaptureV1 | undefined {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CAPTURE_BYTES) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_CAPTURE_BYTES || (opened.mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) return undefined;
    const raw = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
    if (!record(raw)
      || raw.schemaVersion !== TRANSPORT_SCHEMA_VERSION
      || typeof raw.observedAt !== "string"
      || !record(raw.rate_limits)) return undefined;
    const observedMs = Date.parse(raw.observedAt);
    if (!Number.isFinite(observedMs)
      || observedMs > nowMs + MAX_FUTURE_SKEW_MS
      || nowMs - observedMs > maxAgeMs) return undefined;
    const projected = projectStoredRateLimits(raw.rate_limits);
    if (!projected) return undefined;
    return { schemaVersion: TRANSPORT_SCHEMA_VERSION, observedAt: new Date(observedMs).toISOString(), rate_limits: projected };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function projectStoredRateLimits(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const field of ["five_hour", "seven_day"] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (!record(value)) return undefined;
    const projected: Record<string, number> = {};
    if (typeof value.used_percentage !== "number" || !Number.isFinite(value.used_percentage)) return undefined;
    projected.used_percentage = value.used_percentage;
    if (value.resets_at !== undefined && value.resets_at !== null) {
      if (typeof value.resets_at !== "number" || !Number.isFinite(value.resets_at)) return undefined;
      projected.resets_at = value.resets_at;
    }
    out[field] = projected;
  }
  return out;
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("capture directory is unsafe");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("capture directory owner is unsafe");
  if ((stat.mode & 0o077) !== 0) throw new Error("capture directory permissions are unsafe");
}

function isPrivateDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    return !stat.isSymbolicLink()
      && stat.isDirectory()
      && (typeof process.getuid !== "function" || stat.uid === process.getuid())
      && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function hasRelayCapacity(relayDir: string, relayName: string): boolean {
  try {
    const entries = fs.readdirSync(relayDir);
    if (entries.length >= MAX_DIRECTORY_ENTRIES) return false;
    if (entries.includes(relayName)) return true;
    return entries.filter((entry) => SAFE_RELAY_FILE.test(entry)).length < MAX_CAPTURE_FILES;
  } catch {
    return false;
  }
}

function readCaptureMarker(file: string): string | undefined {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MARKER_BYTES) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_MARKER_BYTES || (opened.mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) return undefined;
    const raw = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
    if (!record(raw)
      || raw.schemaVersion !== TRANSPORT_SCHEMA_VERSION
      || typeof raw.accountScopeKey !== "string"
      || !SAFE_SCOPE_KEY.test(raw.accountScopeKey)) return undefined;
    return raw.accountScopeKey;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function removeRegularFile(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory()) fs.unlinkSync(file);
  } catch {
    // Revocation cleanup is best-effort; an unsafe marker still fails closed in both host and wrapper readers.
  }
}

function removeScopeDirectory(root: string, scopeKey: string): void {
  const scopeDir = path.join(root, scopeKey);
  try {
    const stat = fs.lstatSync(scopeDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.unlinkSync(scopeDir);
      return;
    }
    const trash = path.join(root, `.scope-removing-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    fs.renameSync(scopeDir, trash);
    fs.rmSync(trash, { recursive: true, force: true });
  } catch {
    // Preference revocation remains authoritative even if stale reduced captures cannot be deleted immediately.
  }
}

function atomicPrivateWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(fd, content, "utf8");
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

function defaultManagedSettingsPaths(): string[] {
  if (process.platform === "darwin") {
    return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    return [path.join(programFiles, "ClaudeCode", "managed-settings.json")];
  }
  return ["/etc/claude-code/managed-settings.json"];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function boundedPositiveInteger(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`Claude status-line ${label} must be an integer between 1 and ${max}ms`);
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error("Claude status-line capture read cancelled");
  error.name = "AbortError";
  return error;
}

/** Self-contained CommonJS relay materialized into extension global storage. */
export const CLAUDE_STATUS_LINE_CAPTURE_WRAPPER_SOURCE = String.raw`#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RELAY_BYTES = 8 * 1024;
const MAX_MARKER_BYTES = 512;
const MAX_COMMAND_BYTES = 4 * 1024;
const MAX_RESET_EPOCH_SECONDS = 253402300799;
const CAPTURE_MARKER_FILE = "capture-enabled.json";
const SAFE_SCOPE_KEY = /^ps_[0-9a-f]{16,64}$/;

function ownPrivateFile(file) {
  let fd;
  try {
    const resolved = path.resolve(file);
    if (!/^[0-9a-f]{32}\.relay\.json$/.test(path.basename(resolved))) return null;
    const dir = path.dirname(resolved);
    if (path.basename(dir) !== "relays") return null;
    const root = path.dirname(dir);
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) return null;
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && rootStat.uid !== process.getuid()) return null;
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RELAY_BYTES || (stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    const raw = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1) return null;
    const command = raw.priorCommand;
    if (command !== null && (typeof command !== "string" || command.length === 0 || command.indexOf("\0") >= 0 || Buffer.byteLength(command) > MAX_COMMAND_BYTES)) return null;
    return { command, root, target: path.basename(resolved).replace(/\.relay\.json$/, "") };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function activeScope(root) {
  let fd;
  try {
    const marker = path.join(root, CAPTURE_MARKER_FILE);
    fd = fs.openSync(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES || (stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    const raw = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1
      || typeof raw.accountScopeKey !== "string" || !SAFE_SCOPE_KEY.test(raw.accountScopeKey)) return null;
    const scopeDir = path.join(root, raw.accountScopeKey);
    const scopeStat = fs.lstatSync(scopeDir);
    if (scopeStat.isSymbolicLink() || !scopeStat.isDirectory() || (scopeStat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && scopeStat.uid !== process.getuid()) return null;
    return raw.accountScopeKey;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function invalidWindow() {
  return { used_percentage: -1 };
}

function projectWindow(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidWindow();
  const used = typeof value.used_percentage === "number" && Number.isFinite(value.used_percentage)
    ? value.used_percentage
    : -1;
  const out = { used_percentage: used };
  if (value.resets_at !== undefined && value.resets_at !== null) {
    out.resets_at = typeof value.resets_at === "number" && Number.isSafeInteger(value.resets_at)
      && value.resets_at >= 0 && value.resets_at <= MAX_RESET_EPOCH_SECONDS
      ? value.resets_at
      : -1;
  }
  return out;
}

function projection(input, oversized) {
  if (oversized) return { five_hour: invalidWindow() };
  try {
    const raw = JSON.parse(Buffer.concat(input).toString("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { five_hour: invalidWindow() };
    const limits = raw.rate_limits;
    if (limits === undefined || limits === null) return {};
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) return { five_hour: invalidWindow() };
    const out = {};
    const five = projectWindow(limits.five_hour);
    const seven = projectWindow(limits.seven_day);
    if (five !== undefined) out.five_hour = five;
    if (seven !== undefined) out.seven_day = seven;
    return out;
  } catch {
    return { five_hour: invalidWindow() };
  }
}

function atomicCapture(target, rateLimits) {
  if (!target || activeScope(target.root) !== target.scope) return;
  const file = path.join(target.root, target.scope, target.target + ".capture.json");
  const tmp = file + ".tmp-" + process.pid + "-" + require("node:crypto").randomBytes(4).toString("hex");
  let fd;
  try {
    const dir = path.dirname(file);
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) return;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return;
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(), rate_limits: rateLimits }) + "\n", "utf8");
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const relay = ownPrivateFile(process.argv[2] || "");
if (!relay) {
  process.exitCode = 1;
  process.stdin.resume();
} else {
  const scope = activeScope(relay.root);
  const capture = scope ? { root: relay.root, scope, target: relay.target } : null;
  let child = null;
  if (relay.command) {
    try {
      child = spawn(relay.command, { shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.stdout.pipe(process.stdout, { end: false });
      child.stderr.pipe(process.stderr, { end: false });
      child.stdin.on("error", function () {});
      child.on("error", function () { process.exitCode = 1; });
      child.on("close", function (code) { process.exitCode = typeof code === "number" ? code : 1; });
      process.stdin.pipe(child.stdin);
    } catch {
      process.exitCode = 1;
    }
  }
  if (capture) {
    let bytes = 0;
    let oversized = false;
    const chunks = [];
    process.stdin.on("data", function (chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (!oversized && bytes <= MAX_INPUT_BYTES) chunks.push(value);
      else { oversized = true; chunks.length = 0; }
    });
    process.stdin.on("end", function () { atomicCapture(capture, projection(chunks, oversized)); });
  } else if (!child) {
    // Consent was revoked (or not yet granted): consume stdin without buffering or parsing it.
    process.stdin.resume();
  }
}
`;
