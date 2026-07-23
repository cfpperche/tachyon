import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ensureSecureRuntimeDir, MAX_CONTROL_SOCKET_PATH_BYTES } from "./runtimeSecurity.js";
import { readLinuxProcessIdentity } from "../delivery/reloadReconciliation.js";
import { workspaceHash } from "../tmux/TmuxService.js";
import { DAEMON_SETTING_KEYS, type DaemonSettingsSnapshot } from "../workspace/DaemonEngineHost.js";
import { EngineControlClientError, requestEngineControl } from "./controlClient.js";
import {
  loadStagedEngineBundle,
  verifyStagedBundle,
  verifyStagedEngineRuntime,
  type StagedEngineBundle,
  type StagedEngineRuntime,
} from "./engineBundleStore.js";
import { engineDaemonStateRoot } from "./daemonStateStore.js";
import { ensureEngineStateMigration, type EngineStateMigrationProvider } from "./stateMigration.js";
import {
  engineBundleId,
  isEngineBundleManifestV1,
  isEngineReleaseChannel,
  type EngineBundleManifestV1,
  type EngineServiceIdentityV1,
} from "./protocol.js";
import type { StartDaemonEngineServiceOptions } from "./engineService.js";

const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 40;
const MAX_ENCODED_DAEMON_OPTIONS_BYTES = 64 * 1024;
const SYSTEMD_OUTPUT_LIMIT = 8 * 1024;
const MAX_TRANSITION_AUDIT_BYTES = 4 * 1024 * 1024;
const MAX_TRANSITION_AUDIT_LINE_BYTES = 8 * 1024;
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
  "XDG_CACHE_HOME",
  // Dev Host F5 sets these on the Extension Host for isolation; the engine owns tmux/worktrees
  // and must share them or attach/spawn land on the default fleet socket (/tmp).
  "TMUX_TMPDIR",
  "TACHYON_DEV_HOST",
  "TACHYON_DEV_HOST_PROFILE_HOME",
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

export interface EngineDaemonStopInput {
  workspaceRoot: string;
  workspaceHash: string;
  controlSocketPath: string;
  unitName: string;
  expectedIdentity?: EngineServiceIdentityV1;
  timeoutMs: number;
  pollMs: number;
}

export type EngineDaemonStopper = (input: EngineDaemonStopInput) => Promise<void>;

export interface EnsureDaemonEngineOptions {
  workspaceRoot: string;
  bundle: StagedEngineBundle;
  /** Immutable Tachyon-owned runtime. Production must never launch from a VS Code version directory. */
  runtime: StagedEngineRuntime;
  settings?: DaemonSettingsSnapshot;
  /** Lazily reads the exact legacy allowlist before first launch; never enters daemon argv. */
  migrationProvider?: EngineStateMigrationProvider;
  launcher?: EngineDaemonLauncher;
  stopper?: EngineDaemonStopper;
  startTimeoutMs?: number;
  pollMs?: number;
  /** Test/platform adapter overrides. Production derives private per-user locations. */
  controlSocketPath?: string;
  storageRoot?: string;
}

export interface EnsuredDaemonEngine {
  identity: EngineServiceIdentityV1;
  controlSocketPath: string;
  disposition: "started" | "contended" | "reused-exact" | "reused-compatible" | "upgraded";
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
  try { verifyStagedEngineRuntime(options.runtime); }
  catch (error) {
    throw new EngineSupervisorError("RUNTIME_VERIFICATION_FAILED", "the staged Tachyon engine runtime failed verification", boundedError(error));
  }
  const hash = workspaceHash(canonicalRoot);
  if (options.controlSocketPath && !path.isAbsolute(options.controlSocketPath)) {
    throw new EngineSupervisorError("INVALID_OPTIONS", "persistent engine control socket path must be absolute");
  }
  const controlSocketPath = options.controlSocketPath ?? engineControlSocketPath(canonicalRoot);
  assertControlSocketPath(controlSocketPath);
  const storageRoot = path.resolve(options.storageRoot ?? engineStorageRoot(canonicalRoot));
  const timeoutMs = positiveInteger(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, "engine startTimeoutMs");
  const pollMs = positiveInteger(options.pollMs ?? DEFAULT_POLL_MS, "engine pollMs");
  const launcher = options.launcher ?? launchEngineDaemonWithSystemd;
  const stopper = options.stopper ?? stopEngineDaemonWithSystemd;
  if (options.controlSocketPath) ensureSecureRuntimeDir(path.dirname(controlSocketPath));
  else ensureSecureEngineRuntimeDir(canonicalRoot);
  // t-13cc6e — the entry probe shares the transient window of the wait loops: another shell's
  // just-launched daemon may have bound the socket without answering health yet (750ms request
  // budget, easily outlived under load). Poll a bound-but-unverifiable endpoint until the deadline
  // instead of hard-failing the first probe; a still-unverifiable endpoint at the deadline re-raises
  // CONTROL_UNAVAILABLE, and the launch path below stays reachable only through a proven-absent probe.
  const entryDeadline = Date.now() + timeoutMs;
  let existing: EngineServiceIdentityV1 | undefined;
  for (;;) {
    try {
      existing = await probeHealthyEngine(controlSocketPath, canonicalRoot, hash);
      break;
    } catch (error) {
      if (!(error instanceof EngineSupervisorError && error.code === "CONTROL_UNAVAILABLE")) throw error;
      if (Date.now() >= entryDeadline) throw error;
      await delay(pollMs);
    }
  }
  if (existing) {
    const action = classifyRunningBundle(existing, options.bundle, manifest);
    if (action === "upgrade") {
      return upgradeDaemonEngine({
        canonicalRoot,
        workspaceHash: hash,
        controlSocketPath,
        storageRoot,
        desiredBundle: options.bundle,
        desiredManifest: manifest,
        runtime: options.runtime,
        settings: options.settings,
        launcher,
        stopper,
        timeoutMs,
        pollMs,
      });
    }
    return {
      identity: existing,
      controlSocketPath,
      disposition: action === "exact" ? "reused-exact" : "reused-compatible",
    };
  }
  assertAbsentOrStaleSocket(controlSocketPath);
  if (options.migrationProvider) {
    await ensureEngineStateMigration(engineDaemonStateRoot(storageRoot), hash, options.migrationProvider);
  }
  const launchInput = buildLaunchInput({
    canonicalRoot,
    storageRoot,
    controlSocketPath,
    bundle: options.bundle,
    manifest,
    runtime: options.runtime,
    settings: options.settings,
  });
  const outcome = await launcher(launchInput);
  const identity = await waitForCompatibleEngine({
    controlSocketPath,
    canonicalRoot,
    workspaceHash: hash,
    manifest,
    timeoutMs,
    pollMs,
    unitName: launchInput.unitName,
  });
  return {
    identity,
    controlSocketPath,
    disposition: outcome === "started" && identity.bundleId === options.bundle.bundleId ? "started" : "contended",
  };
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
    "channel",
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
    || (candidate.channel !== undefined && !isEngineReleaseChannel(candidate.channel))
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

export async function stopEngineDaemonWithSystemd(input: EngineDaemonStopInput): Promise<void> {
  if (process.platform !== "linux") {
    throw new EngineSupervisorError("UNSUPPORTED_PLATFORM", `persistent engine launcher is not yet supported on ${process.platform}`);
  }
  if (input.expectedIdentity) {
    const current = await probeHealthyEngine(input.controlSocketPath, input.workspaceRoot, input.workspaceHash);
    if (current && !sameEngineIdentity(current, input.expectedIdentity)) {
      throw new EngineSupervisorError(
        "ENGINE_CHANGED_DURING_UPGRADE",
        "Tachyon's engine changed before the controlled upgrade could stop it.",
      );
    }
    if (!current && !processIdentityStillExact(input.expectedIdentity)) {
      throw new EngineSupervisorError(
        "ENGINE_CHANGED_DURING_UPGRADE",
        "Tachyon's engine disappeared before the controlled upgrade could stop it; retrying later is safer than stopping a replacement.",
      );
    }
  }
  const stopped = await runSystemctl(["--user", "stop", input.unitName]);
  if (stopped.code !== 0) {
    const current = await probeHealthyEngine(input.controlSocketPath, input.workspaceRoot, input.workspaceHash);
    if (current) throw systemdStopError(stopped);
  }
  // A failed transient unit may otherwise remain loaded just long enough to make the replacement launch
  // look contended. reset-failed is harmless for a clean stopped unit and --collect then unloads it.
  await runSystemctl(["--user", "reset-failed", input.unitName]).catch(() => ({ code: 1, output: "" }));
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const expectedGone = !input.expectedIdentity || !processIdentityStillExact(input.expectedIdentity);
    const state = await runSystemctl(["--user", "show", "--property=LoadState", "--value", input.unitName]);
    if (expectedGone && state.code === 0 && state.output.trim() === "not-found") return;
    await delay(input.pollMs);
  }
  throw new EngineSupervisorError(
    "ENGINE_STOP_TIMEOUT",
    "Tachyon's previous engine did not stop in time; the upgrade was not attempted.",
    `unit=${input.unitName}`,
  );
}

interface UpgradeDaemonEngineInput {
  canonicalRoot: string;
  workspaceHash: string;
  controlSocketPath: string;
  storageRoot: string;
  desiredBundle: StagedEngineBundle;
  desiredManifest: EngineBundleManifestV1;
  runtime: StagedEngineRuntime;
  settings?: DaemonSettingsSnapshot;
  launcher: EngineDaemonLauncher;
  stopper: EngineDaemonStopper;
  timeoutMs: number;
  pollMs: number;
}

async function upgradeDaemonEngine(input: UpgradeDaemonEngineInput): Promise<EnsuredDaemonEngine> {
  const lockPath = path.join(path.dirname(input.controlSocketPath), "upgrade.lock");
  return withEngineUpgradeLock(lockPath, input.timeoutMs, input.pollMs, async () => {
    const current = await probeHealthyEngine(
      input.controlSocketPath,
      input.canonicalRoot,
      input.workspaceHash,
    );
    if (!current) {
      const launchInput = buildLaunchInput({
        canonicalRoot: input.canonicalRoot,
        storageRoot: input.storageRoot,
        controlSocketPath: input.controlSocketPath,
        bundle: input.desiredBundle,
        manifest: input.desiredManifest,
        runtime: input.runtime,
        settings: input.settings,
      });
      const outcome = await input.launcher(launchInput);
      const identity = await waitForExactEngine({ ...input, manifest: input.desiredManifest, bundle: input.desiredBundle });
      return {
        identity,
        controlSocketPath: input.controlSocketPath,
        disposition: outcome === "started" ? "started" : "contended",
      };
    }

    const action = classifyRunningBundle(current, input.desiredBundle, input.desiredManifest);
    if (action !== "upgrade") {
      return {
        identity: current,
        controlSocketPath: input.controlSocketPath,
        disposition: action === "exact" ? "reused-exact" : "reused-compatible",
      };
    }

    let rollbackBundle: StagedEngineBundle;
    let rollbackManifest: EngineBundleManifestV1;
    try {
      rollbackBundle = loadStagedEngineBundle(path.dirname(input.desiredBundle.root), current.bundleId);
      rollbackManifest = readVerifiedManifest(rollbackBundle);
    } catch (error) {
      throw new EngineSupervisorError(
        "ROLLBACK_BUNDLE_UNAVAILABLE",
        "Tachyon kept the running engine because its verified rollback bundle is unavailable.",
        boundedError(error),
      );
    }
    if (rollbackManifest.engineVersion !== current.engineVersion
      || !sameProtocolRange(rollbackManifest.protocol, current.protocol)) {
      throw new EngineSupervisorError(
        "ROLLBACK_BUNDLE_MISMATCH",
        "Tachyon kept the running engine because its rollback bundle does not match the live incarnation.",
      );
    }

    const transitionId = randomUUID();
    appendUpgradeAudit(input.storageRoot, {
      schemaVersion: 1,
      at: new Date().toISOString(),
      transitionId,
      phase: "prepared",
      from: auditIdentity(current),
      to: { bundleId: input.desiredBundle.bundleId, engineVersion: input.desiredManifest.engineVersion },
    });

    const stopInput = (expectedIdentity?: EngineServiceIdentityV1): EngineDaemonStopInput => ({
      workspaceRoot: input.canonicalRoot,
      workspaceHash: input.workspaceHash,
      controlSocketPath: input.controlSocketPath,
      unitName: engineSystemdUnitName(input.canonicalRoot),
      expectedIdentity,
      timeoutMs: input.timeoutMs,
      pollMs: input.pollMs,
    });
    let oldStopped = false;
    try {
      await input.stopper(stopInput(current));
      oldStopped = true;
      const verifiedDesiredManifest = readVerifiedManifest(input.desiredBundle);
      const desiredLaunch = buildLaunchInput({
        canonicalRoot: input.canonicalRoot,
        storageRoot: input.storageRoot,
        controlSocketPath: input.controlSocketPath,
        bundle: input.desiredBundle,
        manifest: verifiedDesiredManifest,
        runtime: input.runtime,
        settings: input.settings,
      });
      await input.launcher(desiredLaunch);
      const upgraded = await waitForExactEngine({ ...input, manifest: verifiedDesiredManifest, bundle: input.desiredBundle });
      if (sameEngineIdentity(upgraded, current)) {
        throw new EngineSupervisorError("ENGINE_UPGRADE_NO_TRANSITION", "the engine upgrade did not create a new incarnation");
      }
      appendUpgradeAudit(input.storageRoot, {
        schemaVersion: 1,
        at: new Date().toISOString(),
        transitionId,
        phase: "committed",
        from: auditIdentity(current),
        to: auditIdentity(upgraded),
      });
      return { identity: upgraded, controlSocketPath: input.controlSocketPath, disposition: "upgraded" };
    } catch (upgradeError) {
      if (!oldStopped) {
        appendUpgradeAudit(input.storageRoot, {
          schemaVersion: 1,
          at: new Date().toISOString(),
          transitionId,
          phase: "stop-refused",
          from: auditIdentity(current),
          error: boundedError(upgradeError),
        });
        throw upgradeError;
      }

      let restored: EngineServiceIdentityV1;
      try {
        const occupant = await probeHealthyEngine(input.controlSocketPath, input.canonicalRoot, input.workspaceHash);
        if (occupant && occupant.bundleId !== input.desiredBundle.bundleId) {
          throw new EngineSupervisorError(
            "ENGINE_CHANGED_DURING_ROLLBACK",
            "Tachyon found an unexpected engine while preparing rollback and refused to stop it.",
          );
        }
        await input.stopper(stopInput(occupant));
        const verifiedRollbackManifest = readVerifiedManifest(rollbackBundle);
        const rollbackLaunch = buildLaunchInput({
          canonicalRoot: input.canonicalRoot,
          storageRoot: input.storageRoot,
          controlSocketPath: input.controlSocketPath,
          bundle: rollbackBundle,
          manifest: verifiedRollbackManifest,
          runtime: input.runtime,
          settings: input.settings,
        });
        await input.launcher(rollbackLaunch);
        restored = await waitForExactEngine({ ...input, manifest: verifiedRollbackManifest, bundle: rollbackBundle });
        if (sameEngineIdentity(restored, current)) {
          throw new EngineSupervisorError("ENGINE_ROLLBACK_NO_TRANSITION", "engine rollback did not create a new incarnation");
        }
      } catch (rollbackError) {
        appendUpgradeAudit(input.storageRoot, {
          schemaVersion: 1,
          at: new Date().toISOString(),
          transitionId,
          phase: "rollback-failed",
          from: auditIdentity(current),
          attemptedBundleId: input.desiredBundle.bundleId,
          upgradeError: boundedError(upgradeError),
          rollbackError: boundedError(rollbackError),
        });
        throw new EngineSupervisorError(
          "ENGINE_UPGRADE_ROLLBACK_FAILED",
          "Tachyon could not start either the new engine or its verified rollback. Run Tachyon: Doctor.",
          `upgrade=${boundedError(upgradeError)} rollback=${boundedError(rollbackError)}`,
        );
      }
      appendUpgradeAudit(input.storageRoot, {
        schemaVersion: 1,
        at: new Date().toISOString(),
        transitionId,
        phase: "rolled-back",
        from: auditIdentity(current),
        attemptedBundleId: input.desiredBundle.bundleId,
        restored: auditIdentity(restored),
        error: boundedError(upgradeError),
      });
      throw new EngineSupervisorError(
        "ENGINE_UPGRADE_ROLLED_BACK",
        "Tachyon restored the previous engine because the new version did not become healthy.",
        `transition=${transitionId} restored=${restored.instanceId} cause=${boundedError(upgradeError)}`,
      );
    }
  });
}

function buildLaunchInput(input: {
  canonicalRoot: string;
  storageRoot: string;
  controlSocketPath: string;
  bundle: StagedEngineBundle;
  manifest: EngineBundleManifestV1;
  runtime: StagedEngineRuntime;
  settings?: DaemonSettingsSnapshot;
}): EngineDaemonLaunchInput {
  const options: EngineDaemonOptionsV1 = {
    schemaVersion: 1,
    workspaceRoot: input.canonicalRoot,
    storageRoot: input.storageRoot,
    mediaRoot: input.bundle.root,
    controlSocketPath: input.controlSocketPath,
    appVersion: input.manifest.engineVersion,
    bundleId: input.bundle.bundleId,
    ...(input.manifest.channel === undefined ? {} : { channel: input.manifest.channel }),
    settings: input.settings,
  };
  return {
    options,
    daemonModule: input.bundle.entrypoint,
    encodedOptions: encodeEngineDaemonOptions(options),
    unitName: engineSystemdUnitName(input.canonicalRoot),
    nodePath: input.runtime.executable,
  };
}

function classifyRunningBundle(
  running: EngineServiceIdentityV1,
  desiredBundle: StagedEngineBundle,
  desiredManifest: EngineBundleManifestV1,
): "exact" | "compatible" | "upgrade" {
  const compatible = protocolRangesOverlap(running.protocol, desiredManifest.protocol);
  const desiredChannel = desiredManifest.channel;
  const runningChannel = running.channel;
  if (desiredChannel !== undefined && runningChannel !== undefined && desiredChannel !== runningChannel) {
    throw new EngineSupervisorError(
      "ENGINE_CHANNEL_CONFLICT",
      `a ${runningChannel} Tachyon engine cannot be replaced or reused by the ${desiredChannel} channel`,
    );
  }
  if (running.bundleId === desiredBundle.bundleId) {
    if (running.engineVersion !== desiredManifest.engineVersion
      || !sameProtocolRange(running.protocol, desiredManifest.protocol)
      || (desiredChannel !== undefined && runningChannel !== desiredChannel)) {
      throw new EngineSupervisorError("BUNDLE_IDENTITY_MISMATCH", "the live engine identity does not match its staged bundle");
    }
    return "exact";
  }
  const comparison = compareEngineVersions(desiredManifest.engineVersion, running.engineVersion);
  if (comparison === 0 && desiredChannel === "stable") {
    throw new EngineSupervisorError(
      "ENGINE_VERSION_CONTENT_CONFLICT",
      `stable Tachyon ${desiredManifest.engineVersion} has different bundle bytes; bump the version before installing it`,
    );
  }
  if (comparison === 0 && desiredChannel === "dev") return "upgrade";
  if (comparison !== undefined && comparison > 0) return "upgrade";
  if (compatible) return "compatible";
  throw new EngineSupervisorError(
    "INCOMPATIBLE_ENGINE",
    comparison !== undefined && comparison < 0
      ? "a newer incompatible Tachyon engine is already running; an older extension cannot downgrade it"
      : "the running Tachyon engine is not protocol-compatible with this extension version",
  );
}

function compareEngineVersions(desired: string, running: string): number | undefined {
  const parse = (value: string): [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) return undefined;
    const parts = match.slice(1, 4).map(Number);
    return parts.every(Number.isSafeInteger) ? parts as [number, number, number] : undefined;
  };
  const left = parse(desired);
  const right = parse(running);
  if (!left || !right) return undefined;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]! ? 1 : -1;
  }
  return 0;
}

async function waitForCompatibleEngine(input: {
  controlSocketPath: string;
  canonicalRoot: string;
  workspaceHash: string;
  manifest: EngineBundleManifestV1;
  timeoutMs: number;
  pollMs: number;
  unitName: string;
}): Promise<EngineServiceIdentityV1> {
  const deadline = Date.now() + input.timeoutMs;
  let lastUnverifiable: EngineSupervisorError | undefined;
  while (Date.now() < deadline) {
    let identity: EngineServiceIdentityV1 | undefined;
    try {
      identity = await probeHealthyEngine(input.controlSocketPath, input.canonicalRoot, input.workspaceHash);
      lastUnverifiable = undefined;
    } catch (error) {
      // t-13cc6e — a bound-but-not-yet-answering endpoint is TRANSIENT while the elected daemon is
      // still starting (its 750ms health window can lapse under load between bind and first reply).
      // Keep polling until the deadline instead of hard-failing the loser shell on the first probe;
      // every other supervisor error stays terminal, and a still-unverifiable endpoint at the
      // deadline re-raises CONTROL_UNAVAILABLE — never a duplicate launch.
      if (!(error instanceof EngineSupervisorError && error.code === "CONTROL_UNAVAILABLE")) throw error;
      lastUnverifiable = error;
    }
    if (identity) {
      if (input.manifest.channel !== undefined && identity.channel !== input.manifest.channel) {
        throw new EngineSupervisorError(
          "ENGINE_CHANNEL_CONFLICT",
          `the elected ${identity.channel ?? "legacy"} Tachyon engine does not match the ${input.manifest.channel} channel`,
        );
      }
      if (!protocolRangesOverlap(identity.protocol, input.manifest.protocol)) {
        throw new EngineSupervisorError("INCOMPATIBLE_ENGINE", "the elected Tachyon engine is not protocol-compatible");
      }
      return identity;
    }
    await delay(input.pollMs);
  }
  if (lastUnverifiable) throw lastUnverifiable;
  throw new EngineSupervisorError(
    "ENGINE_START_TIMEOUT",
    "Tachyon's persistent engine did not become ready in time. Run Tachyon: Doctor and retry.",
    `unit=${input.unitName} socket=${input.controlSocketPath}`,
  );
}

async function waitForExactEngine(input: UpgradeDaemonEngineInput & {
  manifest: EngineBundleManifestV1;
  bundle: StagedEngineBundle;
}): Promise<EngineServiceIdentityV1> {
  const deadline = Date.now() + input.timeoutMs;
  let lastUnverifiable: EngineSupervisorError | undefined;
  while (Date.now() < deadline) {
    let identity: EngineServiceIdentityV1 | undefined;
    try {
      identity = await probeHealthyEngine(input.controlSocketPath, input.canonicalRoot, input.workspaceHash);
      lastUnverifiable = undefined;
    } catch (error) {
      // t-13cc6e — same transient window as waitForCompatibleEngine: the replacement daemon binds
      // its socket before it can answer health, so an unverifiable endpoint keeps polling until the
      // deadline rather than aborting the controlled transition on the first slow probe.
      if (!(error instanceof EngineSupervisorError && error.code === "CONTROL_UNAVAILABLE")) throw error;
      lastUnverifiable = error;
    }
    if (identity) {
      if (identity.bundleId !== input.bundle.bundleId
        || identity.engineVersion !== input.manifest.engineVersion
        || (input.manifest.channel !== undefined && identity.channel !== input.manifest.channel)
        || !sameProtocolRange(identity.protocol, input.manifest.protocol)) {
        throw new EngineSupervisorError(
          "ENGINE_UPGRADE_OCCUPIED",
          "a different engine won the service identity during the controlled transition",
          `expected=${input.bundle.bundleId} actual=${identity.bundleId}`,
        );
      }
      return identity;
    }
    await delay(input.pollMs);
  }
  if (lastUnverifiable) throw lastUnverifiable;
  throw new EngineSupervisorError(
    "ENGINE_START_TIMEOUT",
    "Tachyon's persistent engine did not become ready in time. Run Tachyon: Doctor and retry.",
    `unit=${engineSystemdUnitName(input.canonicalRoot)} socket=${input.controlSocketPath}`,
  );
}

async function probeHealthyEngine(
  socketPath: string,
  canonicalRoot: string,
  hash: string,
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
  const observed = readLinuxProcessIdentity(identity.pid);
  const expectedStart = observed.state === "exact" ? `linux:${observed.bootId}:${observed.processStart}` : undefined;
  if (!expectedStart || expectedStart !== identity.processStartIdentity) {
    throw new EngineSupervisorError("ENGINE_IDENTITY_UNPROVABLE", "persistent engine process identity could not be verified");
  }
  return identity;
}

interface UpgradeLockOwnerV1 {
  schemaVersion: 1;
  pid: number;
  processStartIdentity: string;
  nonce: string;
  createdAt: string;
}

async function withEngineUpgradeLock<T>(
  lockPath: string,
  timeoutMs: number,
  pollMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const observed = readLinuxProcessIdentity(process.pid);
  if (observed.state !== "exact") {
    throw new EngineSupervisorError("UPGRADE_LOCK_IDENTITY_UNAVAILABLE", "the engine upgrade coordinator identity is unavailable");
  }
  const owner: UpgradeLockOwnerV1 = {
    schemaVersion: 1,
    pid: process.pid,
    processStartIdentity: `linux:${observed.bootId}:${observed.processStart}`,
    nonce: randomBytes(24).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  const encoded = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + timeoutMs;
  let lockIdentity: { dev: number; ino: number } | undefined;
  while (!lockIdentity && Date.now() < deadline) {
    const temp = `${lockPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(temp, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        fs.linkSync(temp, lockPath);
        fs.chmodSync(lockPath, 0o600);
        const stat = fs.lstatSync(lockPath);
        lockIdentity = { dev: stat.dev, ino: stat.ino };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      try { fs.unlinkSync(temp); } catch { /* linked or absent */ }
    }
    if (lockIdentity) break;

    const existing = readUpgradeLock(lockPath);
    const live = readLinuxProcessIdentity(existing.owner.pid);
    if (live.state === "unknown") {
      throw new EngineSupervisorError(
        "UPGRADE_LOCK_UNPROVABLE",
        "an existing engine upgrade coordinator could not be verified",
        live.reason,
      );
    }
    const exact = live.state === "exact"
      && `linux:${live.bootId}:${live.processStart}` === existing.owner.processStartIdentity;
    if (!exact) removeUpgradeLockIfUnchanged(lockPath, existing);
    else await delay(pollMs);
  }
  if (!lockIdentity) {
    throw new EngineSupervisorError("UPGRADE_LOCK_TIMEOUT", "another Tachyon process is still upgrading this workspace engine");
  }
  try {
    return await operation();
  } finally {
    const current = readUpgradeLock(lockPath);
    if (current.stat.dev !== lockIdentity.dev
      || current.stat.ino !== lockIdentity.ino
      || current.owner.nonce !== owner.nonce) {
      throw new EngineSupervisorError("UPGRADE_LOCK_CHANGED", "engine upgrade lock identity changed before release");
    }
    fs.unlinkSync(lockPath);
  }
}

function readUpgradeLock(lockPath: string): { owner: UpgradeLockOwnerV1; stat: fs.Stats; encoded: string } {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(lockPath); }
  catch (error) {
    throw new EngineSupervisorError("UPGRADE_LOCK_UNREADABLE", "engine upgrade lock disappeared unexpectedly", boundedError(error));
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new EngineSupervisorError("UPGRADE_LOCK_UNSAFE", "engine upgrade lock is unsafe");
  }
  const encoded = fs.readFileSync(lockPath, "utf8");
  let value: unknown;
  try { value = JSON.parse(encoded); }
  catch { throw new EngineSupervisorError("UPGRADE_LOCK_CORRUPT", "engine upgrade lock is corrupt"); }
  if (!isPlainRecord(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.processStartIdentity !== "string"
    || !/^linux:[a-f0-9-]+:\d+$/.test(value.processStartIdentity)
    || typeof value.nonce !== "string" || !/^[a-f0-9]{48}$/.test(value.nonce)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new EngineSupervisorError("UPGRADE_LOCK_CORRUPT", "engine upgrade lock is corrupt");
  }
  return { owner: value as unknown as UpgradeLockOwnerV1, stat, encoded };
}

function removeUpgradeLockIfUnchanged(
  lockPath: string,
  expected: { stat: fs.Stats; encoded: string },
): void {
  const current = fs.lstatSync(lockPath);
  if (current.dev !== expected.stat.dev || current.ino !== expected.stat.ino
    || fs.readFileSync(lockPath, "utf8") !== expected.encoded) {
    throw new EngineSupervisorError("UPGRADE_LOCK_CHANGED", "engine upgrade lock changed during stale-owner recovery");
  }
  fs.unlinkSync(lockPath);
}

function appendUpgradeAudit(storageRoot: string, record: Record<string, unknown>): void {
  const directory = path.join(storageRoot, "supervisor");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (process.platform !== "win32"
      && ((uid !== undefined && directoryStat.uid !== uid) || (directoryStat.mode & 0o077) !== 0))) {
    throw new EngineSupervisorError("UPGRADE_AUDIT_UNSAFE", "engine upgrade audit directory is unsafe");
  }
  const file = path.join(directory, "transitions.jsonl");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSITION_AUDIT_BYTES
      || (process.platform !== "win32"
        && ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0))) {
      throw new EngineSupervisorError("UPGRADE_AUDIT_UNSAFE", "engine upgrade audit is unsafe");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_TRANSITION_AUDIT_LINE_BYTES) {
    throw new EngineSupervisorError("UPGRADE_AUDIT_TOO_LARGE", "engine upgrade audit record exceeds its size limit");
  }
  const descriptor = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(descriptor, line, undefined, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
}

function auditIdentity(identity: EngineServiceIdentityV1): Record<string, unknown> {
  return {
    workspaceHash: identity.workspaceHash,
    instanceId: identity.instanceId,
    pid: identity.pid,
    processStartIdentity: identity.processStartIdentity,
    bundleId: identity.bundleId,
    channel: identity.channel ?? "legacy",
    engineVersion: identity.engineVersion,
    protocol: identity.protocol,
    bridge: identity.bridge,
  };
}

function sameEngineIdentity(left: EngineServiceIdentityV1, right: EngineServiceIdentityV1): boolean {
  return left.workspaceRoot === right.workspaceRoot
    && left.workspaceHash === right.workspaceHash
    && left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.bundleId === right.bundleId
    && left.bridge.instanceId === right.bridge.instanceId
    && left.bridge.port === right.bridge.port;
}

function processIdentityStillExact(identity: EngineServiceIdentityV1): boolean {
  const observed = readLinuxProcessIdentity(identity.pid);
  return observed.state === "exact"
    && `linux:${observed.bootId}:${observed.processStart}` === identity.processStartIdentity;
}

function protocolRangesOverlap(left: EngineBundleManifestV1["protocol"], right: EngineBundleManifestV1["protocol"]): boolean {
  return Math.max(left.min, right.min) <= Math.min(left.max, right.max);
}

function sameProtocolRange(left: EngineBundleManifestV1["protocol"], right: EngineBundleManifestV1["protocol"]): boolean {
  return left.min === right.min && left.max === right.max;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/\s+/g, " ").trim().slice(0, 1_000);
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

function runSystemctl(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("systemctl", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > SYSTEMD_OUTPUT_LIMIT) output = output.slice(-SYSTEMD_OUTPUT_LIMIT);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => reject(systemdStopError({ error, output })));
    child.once("close", (code) => resolve({ code, output }));
  });
}

function systemdStopError(input: { error?: unknown; code?: number | null; output?: string }): EngineSupervisorError {
  const detail = String(input.output || (input.error instanceof Error ? input.error.message : input.error) || `exit ${input.code ?? "unknown"}`)
    .replace(/\s+/g, " ").trim().slice(0, 800);
  const systemCode = (input.error as NodeJS.ErrnoException | undefined)?.code;
  if (systemCode === "ENOENT") {
    return new EngineSupervisorError("SYSTEMCTL_MISSING", "Tachyon cannot upgrade its persistent engine because systemctl is unavailable.", detail);
  }
  if (/failed to connect to bus|system has not been booted with systemd|no medium found|connection refused/i.test(detail)) {
    return new EngineSupervisorError("SYSTEMD_USER_UNAVAILABLE", "Tachyon cannot upgrade its persistent engine because Linux user services are unavailable.", detail);
  }
  return new EngineSupervisorError("SYSTEMD_STOP_FAILED", "Tachyon could not stop its previous engine; the upgrade was not attempted.", detail);
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
