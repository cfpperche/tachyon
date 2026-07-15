import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ensureSecureRuntimeDir, MAX_CONTROL_SOCKET_PATH_BYTES } from "./runtimeSecurity.js";
import { readLinuxProcessIdentity } from "../delivery/reloadReconciliation.js";
import { workspaceHash } from "../tmux/TmuxService.js";
import { DAEMON_SETTING_KEYS, type DaemonSettingsSnapshot } from "../workspace/DaemonEngineHost.js";
import { EngineControlClientError, requestEngineControl } from "./controlClient.js";
import { verifyStagedBundle, type StagedEngineBundle } from "./engineBundleStore.js";
import { ensureEngineStateMigration, type EngineStateMigrationProvider } from "./stateMigration.js";
import {
  engineBundleId,
  isEngineBundleManifestV1,
  type EngineBundleManifestV1,
  type EngineServiceIdentityV1,
} from "./protocol.js";
import type { StartDaemonEngineServiceOptions } from "./engineService.js";

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 40;
const MAX_ENCODED_DAEMON_OPTIONS_BYTES = 64 * 1024;
const SYSTEMD_OUTPUT_LIMIT = 8 * 1024;
const ENGINE_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
] as const;
const DAEMON_SETTING_KEY_SET = new Set<string>(DAEMON_SETTING_KEYS);

export interface EngineDaemonOptionsV1 extends StartDaemonEngineServiceOptions {
  schemaVersion: 1;
}

export interface EngineDaemonLaunchInput {
  options: EngineDaemonOptionsV1;
  daemonModule: string;
  encodedOptions: string;
  unitName: string;
  nodePath: string;
}

export type EngineDaemonLaunchOutcome = "started" | "contended";
export type EngineDaemonLauncher = (input: EngineDaemonLaunchInput) => Promise<EngineDaemonLaunchOutcome>;

export interface EnsureDaemonEngineOptions {
  workspaceRoot: string;
  bundle: StagedEngineBundle;
  settings?: DaemonSettingsSnapshot;
  /** Lazily reads the exact legacy allowlist before first launch; never enters daemon argv. */
  migrationProvider?: EngineStateMigrationProvider;
  launcher?: EngineDaemonLauncher;
  startTimeoutMs?: number;
  pollMs?: number;
  /** Test/platform adapter overrides. Production derives private per-user locations. */
  controlSocketPath?: string;
  storageRoot?: string;
}

export interface EnsuredDaemonEngine {
  identity: EngineServiceIdentityV1;
  controlSocketPath: string;
  disposition: "started" | "contended" | "reused-exact" | "reused-compatible";
}

export class EngineSupervisorError extends Error {
  constructor(readonly code: string, message: string, readonly technicalDetail?: string) {
    super(message);
    this.name = "EngineSupervisorError";
  }
}

/**
 * Ensures one persistent engine for one canonical workspace.  Cross-process election is delegated to
 * the deterministic Linux user-service unit; the control socket remains the authority for readiness and
 * exact identity.  A contending shell waits for that authority instead of constructing a second Workspace.
 */
export async function ensureDaemonEngine(options: EnsureDaemonEngineOptions): Promise<EnsuredDaemonEngine> {
  if (process.platform !== "linux" && !options.launcher) {
    throw new EngineSupervisorError("UNSUPPORTED_PLATFORM", `persistent engine launcher is not yet supported on ${process.platform}`);
  }
  const canonicalRoot = fs.realpathSync(options.workspaceRoot);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new EngineSupervisorError("INVALID_WORKSPACE", "workspace root is not a directory");
  const manifest = readVerifiedManifest(options.bundle);
  const hash = workspaceHash(canonicalRoot);
  if (options.controlSocketPath && !path.isAbsolute(options.controlSocketPath)) {
    throw new EngineSupervisorError("INVALID_OPTIONS", "persistent engine control socket path must be absolute");
  }
  const controlSocketPath = options.controlSocketPath ?? engineControlSocketPath(canonicalRoot);
  assertControlSocketPath(controlSocketPath);
  const storageRoot = path.resolve(options.storageRoot ?? engineStorageRoot(canonicalRoot));
  if (options.controlSocketPath) ensureSecureRuntimeDir(path.dirname(controlSocketPath));
  else ensureSecureEngineRuntimeDir(canonicalRoot);
  const existing = await probeHealthyEngine(controlSocketPath, canonicalRoot, hash, manifest);
  if (existing) {
    return {
      identity: existing,
      controlSocketPath,
      disposition: existing.bundleId === options.bundle.bundleId ? "reused-exact" : "reused-compatible",
    };
  }
  assertAbsentOrStaleSocket(controlSocketPath);
  if (options.migrationProvider) await ensureEngineStateMigration(storageRoot, hash, options.migrationProvider);

  const daemonOptions: EngineDaemonOptionsV1 = {
    schemaVersion: 1,
    workspaceRoot: canonicalRoot,
    storageRoot,
    mediaRoot: options.bundle.root,
    controlSocketPath,
    appVersion: manifest.engineVersion,
    bundleId: options.bundle.bundleId,
    settings: options.settings,
  };
  const launchInput: EngineDaemonLaunchInput = {
    options: daemonOptions,
    daemonModule: options.bundle.entrypoint,
    encodedOptions: encodeEngineDaemonOptions(daemonOptions),
    unitName: engineSystemdUnitName(canonicalRoot),
    nodePath: process.execPath,
  };
  const outcome = await (options.launcher ?? launchEngineDaemonWithSystemd)(launchInput);
  const timeoutMs = positiveInteger(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, "engine startTimeoutMs");
  const pollMs = positiveInteger(options.pollMs ?? DEFAULT_POLL_MS, "engine pollMs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await probeHealthyEngine(controlSocketPath, canonicalRoot, hash, manifest);
    if (identity) {
      const wonExactBundle = identity.bundleId === options.bundle.bundleId;
      return {
        identity,
        controlSocketPath,
        disposition: outcome === "started" && wonExactBundle ? "started" : "contended",
      };
    }
    await delay(pollMs);
  }
  throw new EngineSupervisorError(
    "ENGINE_START_TIMEOUT",
    "Tachyon's persistent engine did not become ready in time. Run Tachyon: Doctor and retry.",
    `unit=${launchInput.unitName} socket=${controlSocketPath}`,
  );
}

export function engineWorkspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(fs.realpathSync(workspaceRoot)).digest("hex").slice(0, 32);
}

export function engineRuntimeDir(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (!runtime || !path.isAbsolute(runtime)) {
    throw new EngineSupervisorError(
      "PRIVATE_RUNTIME_UNAVAILABLE",
      "Tachyon's persistent engine requires a private XDG_RUNTIME_DIR on Linux.",
    );
  }
  return path.join(runtime, "tachyon", "engines", engineWorkspaceKey(workspaceRoot));
}

/**
 * Writer-side choke point for the engine socket hierarchy.  XDG_RUNTIME_DIR is the OS-owned private
 * root; every Tachyon-created descendant is then independently rejected if it is a symlink, foreign,
 * or group/other-accessible.  Recursive mkdir plus a leaf-only check is not sufficient here because an
 * attacker-planted intermediate `engines` entry would otherwise be followed silently.
 */
export function ensureSecureEngineRuntimeDir(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (!runtime || !path.isAbsolute(runtime)) {
    throw new EngineSupervisorError(
      "PRIVATE_RUNTIME_UNAVAILABLE",
      "Tachyon's persistent engine requires a private XDG_RUNTIME_DIR on Linux.",
    );
  }
  const tachyon = path.join(runtime, "tachyon");
  ensureSecureRuntimeDir(tachyon);
  const engines = path.join(tachyon, "engines");
  ensureSecureRuntimeDir(engines);
  const workspace = path.join(engines, engineWorkspaceKey(workspaceRoot));
  ensureSecureRuntimeDir(workspace);
  return workspace;
}

export function engineControlSocketPath(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const socketPath = path.join(engineRuntimeDir(workspaceRoot, env), "control.sock");
  assertControlSocketPath(socketPath);
  return socketPath;
}

export function engineStorageRoot(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const key = engineWorkspaceKey(workspaceRoot);
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), "Tachyon", "engine-state", key);
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Tachyon", "engine-state", key);
  return path.join(env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state"), "tachyon", "engines", key);
}

export function engineSystemdUnitName(workspaceRoot: string): string {
  return `tachyon-engine-${engineWorkspaceKey(workspaceRoot)}.service`;
}

export function encodeEngineDaemonOptions(options: EngineDaemonOptionsV1): string {
  const encoded = Buffer.from(JSON.stringify(options), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_DAEMON_OPTIONS_BYTES) {
    throw new EngineSupervisorError("DAEMON_OPTIONS_TOO_LARGE", "persistent engine startup options exceed the size limit");
  }
  return encoded;
}

export function decodeEngineDaemonOptions(encoded: string): EngineDaemonOptionsV1 {
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_DAEMON_OPTIONS_BYTES) {
    throw new EngineSupervisorError("DAEMON_OPTIONS_TOO_LARGE", "persistent engine startup options exceed the size limit");
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new EngineSupervisorError("INVALID_DAEMON_OPTIONS", "persistent engine startup options are invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EngineSupervisorError("INVALID_DAEMON_OPTIONS", "persistent engine startup options are invalid");
  }
  const candidate = value as Partial<EngineDaemonOptionsV1> & Record<string, unknown>;
  const allowedKeys = new Set([
    "schemaVersion",
    "workspaceRoot",
    "storageRoot",
    "mediaRoot",
    "controlSocketPath",
    "appVersion",
    "bundleId",
    "settings",
  ]);
  if (candidate.schemaVersion !== 1
    || Object.keys(candidate).some((key) => !allowedKeys.has(key))
    || typeof candidate.workspaceRoot !== "string"
    || typeof candidate.storageRoot !== "string"
    || typeof candidate.mediaRoot !== "string"
    || typeof candidate.controlSocketPath !== "string"
    || typeof candidate.appVersion !== "string"
    || typeof candidate.bundleId !== "string"
    || (candidate.settings !== undefined && !isDaemonSettingsSnapshot(candidate.settings))) {
    throw new EngineSupervisorError("INVALID_DAEMON_OPTIONS", "persistent engine startup options are invalid");
  }
  return candidate as EngineDaemonOptionsV1;
}

export function buildEngineSystemdRunArgs(
  input: EngineDaemonLaunchInput,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args = [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${input.unitName}`,
    `--working-directory=${input.options.workspaceRoot}`,
    "--property=Restart=on-failure",
    "--property=RestartSec=1s",
    "--property=TimeoutStopSec=15s",
    "--property=KillMode=control-group",
    "--property=UMask=0077",
    "--setenv=ELECTRON_RUN_AS_NODE=1",
    "--setenv=TACHYON_ENGINE_SERVICE=1",
  ];
  for (const key of ENGINE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.length <= 4_096 && !value.includes("\0")) args.push(`--setenv=${key}=${value}`);
  }
  args.push("--", input.nodePath, input.daemonModule, input.encodedOptions);
  return args;
}

export async function launchEngineDaemonWithSystemd(input: EngineDaemonLaunchInput): Promise<EngineDaemonLaunchOutcome> {
  if (process.platform !== "linux") {
    throw new EngineSupervisorError("UNSUPPORTED_PLATFORM", `persistent engine launcher is not yet supported on ${process.platform}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("systemd-run", buildEngineSystemdRunArgs(input), {
      cwd: input.options.workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > SYSTEMD_OUTPUT_LIMIT) output = output.slice(-SYSTEMD_OUTPUT_LIMIT);
    };
    const finish = (result: EngineDaemonLaunchOutcome | EngineSupervisorError) => {
      if (settled) return;
      settled = true;
      result instanceof EngineSupervisorError ? reject(result) : resolve(result);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => finish(systemdLaunchError({ error })));
    child.once("close", (code) => {
      if (code === 0) return finish("started");
      if (/unit\s+[^\s]+\s+already exists|already loaded|already exists or has a bad unit/i.test(output)) return finish("contended");
      finish(systemdLaunchError({ code, output }));
    });
  });
}

async function probeHealthyEngine(
  socketPath: string,
  canonicalRoot: string,
  hash: string,
  manifest: EngineBundleManifestV1,
): Promise<EngineServiceIdentityV1 | undefined> {
  let response;
  try {
    response = await requestEngineControl(socketPath, { schemaVersion: 1, op: "health", workspaceHash: hash }, 750);
  } catch (error) {
    if (error instanceof EngineControlClientError
      && error.code === "UNAVAILABLE"
      && (error.systemCode === "ENOENT" || error.systemCode === "ECONNREFUSED")) return undefined;
    throw new EngineSupervisorError(
      "CONTROL_UNAVAILABLE",
      "Tachyon found an engine control endpoint but could not verify it; refusing to start a duplicate.",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    throw new EngineSupervisorError(response.code, `persistent engine refused health verification: ${response.message}`);
  }
  if (response.op !== "health") throw new EngineSupervisorError("INVALID_HEALTH", "persistent engine returned the wrong health response");
  const identity = response.engine;
  if (identity.workspaceRoot !== canonicalRoot || identity.workspaceHash !== hash) {
    throw new EngineSupervisorError("WORKSPACE_IDENTITY_MISMATCH", "persistent engine belongs to a different canonical workspace");
  }
  if (Math.max(identity.protocol.min, manifest.protocol.min) > Math.min(identity.protocol.max, manifest.protocol.max)) {
    throw new EngineSupervisorError("INCOMPATIBLE_ENGINE", "the running Tachyon engine is not protocol-compatible with this extension version");
  }
  const observed = readLinuxProcessIdentity(identity.pid);
  const expectedStart = observed.state === "exact" ? `linux:${observed.bootId}:${observed.processStart}` : undefined;
  if (!expectedStart || expectedStart !== identity.processStartIdentity) {
    throw new EngineSupervisorError("ENGINE_IDENTITY_UNPROVABLE", "persistent engine process identity could not be verified");
  }
  return identity;
}

function readVerifiedManifest(bundle: StagedEngineBundle): EngineBundleManifestV1 {
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(bundle.manifestPath, "utf8")); }
  catch (error) {
    throw new EngineSupervisorError("BUNDLE_MANIFEST_UNREADABLE", "staged engine manifest is unreadable", String(error));
  }
  if (!isEngineBundleManifestV1(manifest) || engineBundleId(manifest) !== bundle.bundleId) {
    throw new EngineSupervisorError("BUNDLE_IDENTITY_MISMATCH", "staged engine bundle identity is invalid");
  }
  try { verifyStagedBundle(bundle.root, manifest); }
  catch (error) {
    throw new EngineSupervisorError(
      "BUNDLE_VERIFICATION_FAILED",
      "staged engine bundle failed integrity verification",
      error instanceof Error ? error.message : String(error),
    );
  }
  const expectedEntrypoint = path.resolve(bundle.root, ...manifest.entrypoint.split("/"));
  if (path.resolve(bundle.entrypoint) !== expectedEntrypoint) {
    throw new EngineSupervisorError("BUNDLE_ENTRYPOINT_MISMATCH", "staged engine entrypoint does not match its manifest");
  }
  return manifest;
}

function systemdLaunchError(input: { error?: unknown; code?: number | null; output?: string }): EngineSupervisorError {
  const detail = String(input.output || (input.error instanceof Error ? input.error.message : input.error) || `exit ${input.code ?? "unknown"}`)
    .replace(/\s+/g, " ").trim().slice(0, 800);
  const systemCode = (input.error as NodeJS.ErrnoException | undefined)?.code;
  if (systemCode === "ENOENT") {
    return new EngineSupervisorError("SYSTEMD_RUN_MISSING", "Tachyon cannot start its persistent engine because systemd-run is unavailable.", detail);
  }
  if (/failed to connect to bus|system has not been booted with systemd|no medium found|connection refused/i.test(detail)) {
    return new EngineSupervisorError("SYSTEMD_USER_UNAVAILABLE", "Tachyon cannot start its persistent engine because Linux user services are unavailable.", detail);
  }
  return new EngineSupervisorError("SYSTEMD_RUN_FAILED", "Tachyon could not start its persistent engine. Run Tachyon: Doctor and retry.", detail);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new EngineSupervisorError("INVALID_OPTIONS", `${name} must be a positive integer`);
  return value;
}

function assertControlSocketPath(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes > MAX_CONTROL_SOCKET_PATH_BYTES) {
    throw new EngineSupervisorError(
      "CONTROL_PATH_TOO_LONG",
      "persistent engine control path exceeds the Unix socket limit",
      `${bytes} bytes: ${socketPath}`,
    );
  }
}

function assertAbsentOrStaleSocket(socketPath: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new EngineSupervisorError(
      "CONTROL_PATH_UNREADABLE",
      "persistent engine control path could not be inspected",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new EngineSupervisorError(
      "CONTROL_PATH_UNSAFE",
      "persistent engine control path is not a real Unix socket; refusing to replace it",
      socketPath,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDaemonSettingsSnapshot(value: unknown): value is DaemonSettingsSnapshot {
  if (!isPlainRecord(value)) return false;
  return Object.keys(value).every((key) => key === "global" || key === "workspace" || key === "workspaceFolder")
    && [value.global, value.workspace, value.workspaceFolder]
      .every((scope) => scope === undefined
        || (isPlainRecord(scope) && Object.keys(scope).every((key) => DAEMON_SETTING_KEY_SET.has(key))));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
