import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  ensureSecurePersistentBridgeDir,
  isPersistentBridgeDescriptor,
  persistentBridgeControlSocket,
  persistentBridgeDescriptorPath,
  persistentBridgeDir,
  resolvePersistentBridgeControlSocket,
  type PersistentBridgeControlRequest,
  type PersistentBridgeControlResponse,
  type PersistentBridgeDescriptor,
} from "./persistentProxyProtocol.js";
import type { PersistentProxyDaemonOptions } from "./persistentProxyDaemon.js";

const START_TIMEOUT_MS = 5_000;
const STALE_START_LOCK_MS = 10_000;
const MAX_LAUNCH_DETAIL_LENGTH = 800;

export type PersistentBridgeLaunchFailureCode =
  | "SYSTEMD_RUN_MISSING"
  | "SYSTEMD_USER_UNAVAILABLE"
  | "SYSTEMD_RUN_FAILED";

export class PersistentBridgeLaunchError extends Error {
  constructor(
    readonly code: PersistentBridgeLaunchFailureCode,
    message: string,
    readonly technicalDetail: string,
  ) {
    super(message);
    this.name = "PersistentBridgeLaunchError";
  }
}

export interface PersistentBridgeSystemdFailureInput {
  spawnError?: unknown;
  exitCode?: number | null;
  output?: string;
  isWsl?: boolean;
}

export interface PersistentBridgeLaunchInput {
  options: PersistentProxyDaemonOptions;
  daemonModule: string;
  encodedOptions: string;
}

export type PersistentBridgeLauncher = (input: PersistentBridgeLaunchInput) => void | Promise<void>;

export class PersistentBridgeService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly workspaceHash: string,
    private readonly daemonModule = path.join(__dirname, "persistent-bridge-daemon.cjs"),
    private readonly launcher: PersistentBridgeLauncher = launchPersistentBridgeDaemon,
  ) {}

  async ensureAndRegister(preferredPort: number, backendPort: number): Promise<PersistentBridgeDescriptor> {
    let existing: PersistentBridgeControlResponse | undefined;
    try {
      existing = await this.request({ op: "health", workspaceHash: this.workspaceHash });
    } catch (error) {
      if (!isAbsentSocket(error)) throw error;
    }
    if (existing?.ok && validDescriptor(existing.descriptor, this.workspaceRoot, this.workspaceHash)) {
      return this.register(backendPort);
    }
    if (existing && !existing.ok) throw new Error(`${existing.code}: ${existing.message}`);
    if (existing?.ok) throw new Error("persistent Bridge identity mismatch");

    ensureSecurePersistentBridgeDir(this.workspaceRoot);
    const lock = path.join(persistentBridgeDir(this.workspaceRoot), "start.lock");
    const lockFd = this.tryAcquireStartLock(lock);
    if (lockFd === undefined) return this.waitForReadyAndRegister(backendPort);
    try {
      this.removeStaleLocalFiles();
      const options: PersistentProxyDaemonOptions = {
        workspaceRoot: this.workspaceRoot,
        workspaceHash: this.workspaceHash,
        preferredPort,
        controlSocket: persistentBridgeControlSocket(this.workspaceRoot),
        descriptorPath: persistentBridgeDescriptorPath(this.workspaceRoot),
      };
      await this.launcher({ options, daemonModule: this.daemonModule, encodedOptions: encodeDaemonOptions(options) });
      return await this.waitForReadyAndRegister(backendPort);
    } finally {
      fs.closeSync(lockFd);
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
    }
  }

  private async waitForReadyAndRegister(backendPort: number): Promise<PersistentBridgeDescriptor> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const health = await this.request({ op: "health", workspaceHash: this.workspaceHash });
        if (health.ok && validDescriptor(health.descriptor, this.workspaceRoot, this.workspaceHash)) {
          return this.register(backendPort);
        }
        if (!health.ok) throw new Error(`${health.code}: ${health.message}`);
        throw new Error("persistent Bridge identity mismatch");
      } catch (error) {
        if (!isAbsentSocket(error)) throw error;
      }
      await delay(40);
    }
    throw new Error("persistent Bridge proxy did not become ready");
  }

  private async register(backendPort: number): Promise<PersistentBridgeDescriptor> {
    const registered = await this.request({ op: "register", workspaceHash: this.workspaceHash, backendPort });
    if (!registered.ok) throw new Error(`${registered.code}: ${registered.message}`);
    return registered.descriptor;
  }

  async detach(backendPort: number): Promise<void> {
    await this.request({ op: "detach", workspaceHash: this.workspaceHash, backendPort }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    const response = await this.request({ op: "stop", workspaceHash: this.workspaceHash });
    if (!response.ok) throw new Error(response.message);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        await this.request({ op: "health", workspaceHash: this.workspaceHash });
      } catch (error) {
        if (isAbsentSocket(error)) return;
        throw error;
      }
      await delay(25);
    }
    throw new Error("persistent Bridge proxy did not stop");
  }

  async health(): Promise<PersistentBridgeDescriptor | undefined> {
    const response = await this.request({ op: "health", workspaceHash: this.workspaceHash }).catch(() => undefined);
    return response?.ok && validDescriptor(response.descriptor, this.workspaceRoot, this.workspaceHash)
      ? response.descriptor
      : undefined;
  }

  private request(request: PersistentBridgeControlRequest): Promise<PersistentBridgeControlResponse> {
    // Reader: an already-running daemon may still be a pre-upgrade one at the legacy in-workspace path.
    const socketPath = resolvePersistentBridgeControlSocket(this.workspaceRoot);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let data = "";
      const timer = setTimeout(() => socket.destroy(new Error("persistent Bridge control timeout")), 1_000);
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string) => {
        data += chunk;
        if (data.length > 32_768) socket.destroy(new Error("persistent Bridge control response too large"));
      });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      socket.once("end", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data) as PersistentBridgeControlResponse); }
        catch { reject(new Error("invalid persistent Bridge control response")); }
      });
    });
  }

  private removeStaleLocalFiles(): void {
    for (const file of [persistentBridgeControlSocket(this.workspaceRoot), persistentBridgeDescriptorPath(this.workspaceRoot)]) {
      try { fs.unlinkSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private tryAcquireStartLock(lock: string): number | undefined {
    try {
      return fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age <= STALE_START_LOCK_MS) return undefined;
      fs.unlinkSync(lock);
      return fs.openSync(lock, "wx", 0o600);
    }
  }
}

export function encodeDaemonOptions(options: PersistentProxyDaemonOptions): string {
  return Buffer.from(JSON.stringify(options)).toString("base64url");
}

export function persistentBridgeSystemdUnitName(workspaceHash: string): string {
  return `tachyon-bridge-${workspaceHash}-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.service`;
}

export function buildPersistentBridgeSystemdRunArgs(input: PersistentBridgeLaunchInput, unitName: string): string[] {
  return [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${unitName}`,
    `--working-directory=${input.options.workspaceRoot}`,
    // Native VS Code/Electron exposes the application binary as process.execPath.
    // Electron only executes the daemon as a Node program with this mode enabled;
    // remote Extension Hosts already expose node here, where the flag is harmless.
    "--setenv=ELECTRON_RUN_AS_NODE=1",
    "--",
    process.execPath,
    input.daemonModule,
    input.encodedOptions,
  ];
}

export async function launchPersistentBridgeDaemon(input: PersistentBridgeLaunchInput): Promise<void> {
  if (process.platform === "linux") {
    const args = buildPersistentBridgeSystemdRunArgs(input, persistentBridgeSystemdUnitName(input.options.workspaceHash));
    await runSystemdRun(args, input.options.workspaceRoot);
    return;
  }

  const child = spawn(process.execPath, [input.daemonModule, input.encodedOptions], {
    cwd: input.options.workspaceRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();
}

function runSystemdRun(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("systemd-run", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 8_192) output = output.slice(-8_192);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => reject(persistentBridgeSystemdLaunchError({ spawnError: error })));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(persistentBridgeSystemdLaunchError({ exitCode: code, output }));
    });
  });
}

export function persistentBridgeSystemdLaunchError(input: PersistentBridgeSystemdFailureInput): PersistentBridgeLaunchError {
  const spawnCode = (input.spawnError as NodeJS.ErrnoException | undefined)?.code;
  const isWsl = input.isWsl ?? detectWslEnvironment();
  const output = boundedLaunchDetail(input.output);
  const spawnDetail = boundedLaunchDetail(input.spawnError instanceof Error ? input.spawnError.message : input.spawnError);
  const technicalDetail = output
    ? `systemd-run exited with code ${input.exitCode ?? "unknown"}: ${output}`
    : spawnDetail || `systemd-run exited with code ${input.exitCode ?? "unknown"} without output`;

  if (spawnCode === "ENOENT") {
    return new PersistentBridgeLaunchError(
      "SYSTEMD_RUN_MISSING",
      isWsl
        ? "Bridge is off because systemd-run is not installed inside WSL. Install or enable systemd, restart WSL, then retry the Bridge."
        : "Bridge is off because systemd-run is not installed. Install systemd for this Linux environment, restart the session, then retry the Bridge.",
      technicalDetail,
    );
  }

  if (/failed to connect to bus|system has not been booted with systemd|no medium found|connection refused|transport endpoint is not connected/i.test(`${output} ${spawnDetail}`)) {
    return new PersistentBridgeLaunchError(
      "SYSTEMD_USER_UNAVAILABLE",
      isWsl
        ? "Bridge is off because WSL user services are not running. Set [boot] systemd=true in /etc/wsl.conf, run wsl --shutdown from Windows, reopen VS Code, then retry the Bridge."
        : "Bridge is off because the Linux user service manager is not running. Start a systemd user session, then retry the Bridge.",
      technicalDetail,
    );
  }

  return new PersistentBridgeLaunchError(
    "SYSTEMD_RUN_FAILED",
    "Bridge could not start as a persistent Linux service. Run Tachyon: Doctor for details, then retry the Bridge.",
    technicalDetail,
  );
}

function boundedLaunchDetail(value: unknown): string {
  const detail = String(value ?? "").replace(/\s+/g, " ").trim();
  if (detail.length <= MAX_LAUNCH_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_LAUNCH_DETAIL_LENGTH - 1)}…`;
}

function detectWslEnvironment(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try { return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft"); }
  catch { return false; }
}

function validDescriptor(descriptor: unknown, workspaceRoot: string, workspaceHash: string): descriptor is PersistentBridgeDescriptor {
  if (!isPersistentBridgeDescriptor(descriptor) || descriptor.workspaceHash !== workspaceHash) return false;
  try { return fs.realpathSync(descriptor.workspaceRoot) === fs.realpathSync(workspaceRoot); }
  catch { return false; }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbsentSocket(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}
