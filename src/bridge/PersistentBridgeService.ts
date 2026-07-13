import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  isPersistentBridgeDescriptor,
  persistentBridgeControlSocket,
  persistentBridgeDescriptorPath,
  persistentBridgeDir,
  type PersistentBridgeControlRequest,
  type PersistentBridgeControlResponse,
  type PersistentBridgeDescriptor,
} from "./persistentProxyProtocol.js";
import type { PersistentProxyDaemonOptions } from "./persistentProxyDaemon.js";

const START_TIMEOUT_MS = 5_000;
const STALE_START_LOCK_MS = 10_000;

export class PersistentBridgeService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly workspaceHash: string,
    private readonly daemonModule = path.join(__dirname, "persistent-bridge-daemon.cjs"),
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

    fs.mkdirSync(persistentBridgeDir(this.workspaceRoot), { recursive: true, mode: 0o700 });
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
      const child = spawn(process.execPath, [this.daemonModule, Buffer.from(JSON.stringify(options)).toString("base64url")], {
        cwd: this.workspaceRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
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
    const socketPath = persistentBridgeControlSocket(this.workspaceRoot);
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
