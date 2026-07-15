import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  findServerPids,
  probeServer,
  snapshotServerPids,
  socketPath,
  type ServerProbe,
} from "../tmux/TmuxService.js";
import { watchdogStep, type WatchdogState } from "../tmux/wedgeWatchdog.js";
import {
  readLinuxProcessIdentity,
  type ObservedProcess,
} from "../delivery/reloadReconciliation.js";
import { ensureSecureRuntimeDir } from "./runtimeSecurity.js";

const DEFAULT_WATCHDOG_MS = 30_000;

interface OwnerRecordV1 {
  schemaVersion: 1;
  pid: number;
  processStartIdentity: string;
  nonce: string;
  createdAt: string;
}

interface OwnerLease {
  release(): void;
}

export type TmuxRecoveryOutcome =
  | { state: "healthy" | "no-server" | "busy"; pids: number[]; diagnostics: string }
  | { state: "recovered"; pids: number[]; diagnostics: string }
  | { state: "refused"; pids: number[]; diagnostics: string; reason: string };

export interface RecoverTmuxServerOptions {
  authorityRoot?: string;
  probe?: () => Promise<ServerProbe>;
  findPids?: () => Promise<number[]>;
  snapshot?: (pids: number[]) => Promise<string>;
  readProcessIdentity?: (pid: number) => ObservedProcess;
  kill?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  socketFilePath?: string;
}

export interface GlobalTmuxWatchdogOptions extends RecoverTmuxServerOptions {
  intervalMs?: number;
  onRecovered?: (outcome: Extract<TmuxRecoveryOutcome, { state: "recovered" }>) => void;
  onError?: (error: unknown) => void;
}

export function tmuxAuthorityRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (!runtime || !path.isAbsolute(runtime)) {
    throw new Error("Tachyon tmux authority requires a private XDG_RUNTIME_DIR");
  }
  const tachyon = path.join(runtime, "tachyon");
  ensureSecureRuntimeDir(tachyon);
  const root = path.join(tachyon, "tmux-authority");
  ensureSecureRuntimeDir(root);
  return root;
}

/**
 * Performs one fail-closed recovery under a process-identity-bound global mutation lock. The socket
 * inode, server PID set and every PID start identity are revalidated before SIGKILL; a replacement
 * socket is never unlinked.
 */
export async function recoverTmuxServer(
  options: RecoverTmuxServerOptions = {},
): Promise<TmuxRecoveryOutcome> {
  const root = options.authorityRoot ?? tmuxAuthorityRuntimeRoot();
  ensureSecureRuntimeDir(root);
  const lease = tryAcquireOwnerLease(path.join(root, "recovery.lock"), options.readProcessIdentity);
  if (!lease) return { state: "busy", pids: [], diagnostics: "" };
  try {
    const probe = await (options.probe ?? probeServer)();
    if (probe.state !== "wedged") {
      return { state: probe.state, pids: [], diagnostics: "" };
    }
    const pids = normalizedPids(probe.pids);
    const diagnostics = await (options.snapshot ?? snapshotServerPids)(pids);
    if (pids.length === 0) {
      return { state: "refused", pids, diagnostics, reason: "wedged server PID identity is unavailable" };
    }

    const currentPids = normalizedPids(await (options.findPids ?? (() => findServerPids()))());
    if (!sameNumbers(pids, currentPids)) {
      return { state: "refused", pids, diagnostics, reason: "tmux server PID set changed before recovery" };
    }
    const readIdentity = options.readProcessIdentity ?? readLinuxProcessIdentity;
    const identities = new Map<number, string>();
    for (const pid of pids) {
      const observed = readIdentity(pid);
      if (observed.state !== "exact" || observed.pid !== pid) {
        return { state: "refused", pids, diagnostics, reason: `tmux server PID ${pid} identity is unprovable` };
      }
      identities.set(pid, `${observed.bootId}:${observed.processStart}`);
    }

    const targetSocket = options.socketFilePath ?? socketPath();
    const socketIdentity = readSocketIdentity(targetSocket);
    if (!socketIdentity) {
      return { state: "refused", pids, diagnostics, reason: "tmux socket identity is unavailable" };
    }
    for (const pid of pids) {
      const observed = readIdentity(pid);
      const identity = observed.state === "exact" ? `${observed.bootId}:${observed.processStart}` : undefined;
      if (observed.state !== "exact" || observed.pid !== pid || identity !== identities.get(pid)) {
        return { state: "refused", pids, diagnostics, reason: `tmux server PID ${pid} changed before recovery` };
      }
    }
    if (!sameSocketIdentity(targetSocket, socketIdentity)) {
      return { state: "refused", pids, diagnostics, reason: "tmux socket changed before recovery" };
    }

    const kill = options.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
    for (const pid of pids) {
      try { kill(pid); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await (options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(300);
    for (const pid of pids) {
      const observed = readIdentity(pid);
      if (observed.state === "unknown") {
        return { state: "refused", pids, diagnostics, reason: `tmux server PID ${pid} exit is unprovable` };
      }
      const identity = observed.state === "exact" ? `${observed.bootId}:${observed.processStart}` : undefined;
      if (identity === identities.get(pid)) {
        return { state: "refused", pids, diagnostics, reason: `tmux server PID ${pid} did not exit` };
      }
    }
    if (sameSocketIdentity(targetSocket, socketIdentity)) fs.unlinkSync(targetSocket);
    return { state: "recovered", pids, diagnostics };
  } finally {
    lease.release();
  }
}

/** One global watchdog leader across every workspace engine; a dead leader is reclaimed by PID identity. */
export class GlobalTmuxWatchdog {
  private leader: OwnerLease | undefined;
  private state: WatchdogState = "idle";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private closed = false;
  private readonly root: string;

  constructor(private readonly options: GlobalTmuxWatchdogOptions = {}) {
    this.root = options.authorityRoot ?? tmuxAuthorityRuntimeRoot();
    ensureSecureRuntimeDir(this.root);
  }

  async start(): Promise<void> {
    await this.pollNow(true);
    this.schedule();
  }

  async pollNow(preflight = false): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      this.leader ??= tryAcquireOwnerLease(
        path.join(this.root, "watchdog.lock"),
        this.options.readProcessIdentity,
      );
      if (!this.leader) return;
      let probe: ServerProbe;
      try {
        probe = await (this.options.probe ?? probeServer)();
      } catch (error) {
        this.state = watchdogStep(this.state, "unknown").next;
        throw error;
      }
      if (this.closed) return;
      const step = watchdogStep(this.state, probe.state);
      this.state = step.next;
      if (probe.state !== "wedged" || (!preflight && step.action !== "recover")) return;
      const outcome = await recoverTmuxServer({ ...this.options, authorityRoot: this.root });
      if (outcome.state === "recovered" && !this.closed) this.options.onRecovered?.(outcome);
      else if (outcome.state === "busy" || outcome.state === "refused") this.state = "armed";
    } finally {
      this.polling = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.leader?.release();
    this.leader = undefined;
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.pollNow().catch((error) => {
        if (!this.closed) {
          try { this.options.onError?.(error); } catch { /* diagnostics must not break scheduling */ }
        }
      }).finally(() => this.schedule());
    }, this.options.intervalMs ?? DEFAULT_WATCHDOG_MS);
  }
}

function tryAcquireOwnerLease(
  lockPath: string,
  readIdentity: (pid: number) => ObservedProcess = readLinuxProcessIdentity,
): OwnerLease | undefined {
  const owner = currentOwner(readIdentity);
  const encoded = `${JSON.stringify(owner)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const temp = `${lockPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(temp, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        fs.linkSync(temp, lockPath);
        const stat = fs.lstatSync(lockPath);
        return {
          release: () => {
            let current: ReturnType<typeof readOwnerFile>;
            try { current = readOwnerFile(lockPath); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
              throw error;
            }
            if (current.stat.dev === stat.dev && current.stat.ino === stat.ino && current.owner.nonce === owner.nonce) {
              fs.unlinkSync(lockPath);
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      try { fs.unlinkSync(temp); } catch { /* linked or absent */ }
    }

    let existing: ReturnType<typeof readOwnerFile>;
    try { existing = readOwnerFile(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const observed = readIdentity(existing.owner.pid);
    if (observed.state === "unknown") return undefined;
    const identity = observed.state === "exact"
      ? `linux:${observed.bootId}:${observed.processStart}`
      : undefined;
    if (identity === existing.owner.processStartIdentity) return undefined;
    let current: fs.Stats;
    try { current = fs.lstatSync(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (current.dev !== existing.stat.dev || current.ino !== existing.stat.ino
      || fs.readFileSync(lockPath, "utf8") !== existing.encoded) return undefined;
    fs.unlinkSync(lockPath);
  }
  return undefined;
}

function currentOwner(readIdentity: (pid: number) => ObservedProcess): OwnerRecordV1 {
  const observed = readIdentity(process.pid);
  if (observed.state !== "exact" || observed.pid !== process.pid) {
    throw new Error("current process identity is unavailable for tmux authority");
  }
  return {
    schemaVersion: 1,
    pid: process.pid,
    processStartIdentity: `linux:${observed.bootId}:${observed.processStart}`,
    nonce: randomBytes(24).toString("hex"),
    createdAt: new Date().toISOString(),
  };
}

function readOwnerFile(lockPath: string): { owner: OwnerRecordV1; stat: fs.Stats; encoded: string } {
  const stat = fs.lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096 || (stat.mode & 0o077) !== 0) {
    throw new Error(`unsafe tmux authority lock: ${lockPath}`);
  }
  const encoded = fs.readFileSync(lockPath, "utf8");
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new Error(`corrupt tmux authority lock: ${lockPath}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`corrupt tmux authority lock: ${lockPath}`);
  const owner = value as Partial<OwnerRecordV1>;
  if (owner.schemaVersion !== 1
    || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0
    || typeof owner.processStartIdentity !== "string" || !/^linux:[0-9a-f-]+:\d+$/u.test(owner.processStartIdentity)
    || typeof owner.nonce !== "string" || !/^[0-9a-f]{48}$/u.test(owner.nonce)
    || typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))) {
    throw new Error(`corrupt tmux authority lock: ${lockPath}`);
  }
  return { owner: owner as OwnerRecordV1, stat, encoded };
}

function normalizedPids(pids: readonly number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))].sort((a, b) => a - b);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readSocketIdentity(filePath: string): { dev: number; ino: number } | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isSocket() || stat.isSymbolicLink()) return undefined;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function sameSocketIdentity(filePath: string, expected: { dev: number; ino: number }): boolean {
  const current = readSocketIdentity(filePath);
  return current?.dev === expected.dev && current.ino === expected.ino;
}
