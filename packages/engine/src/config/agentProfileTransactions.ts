import fs from "node:fs";
import path from "node:path";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import { removeEmptyAgentProfileHome } from "./agentProfileHome.js";
import { closeCanonicalAgentProfile, readCanonicalAgentProfile } from "./agentProfileReader.js";
import { asciiFoldAgentName } from "./nameValidation.js";

export const AGENT_PROFILE_TRANSACTIONS_REL = ".tachyon/canonical-agent-transactions";

export interface AgentProfileAuthorityPort {
  read(agentName: string): Promise<AgentProfileAuthorityRecord | undefined>;
  publish(record: AgentProfileAuthorityRecord, expected: undefined): Promise<void>;
  replace(record: AgentProfileAuthorityRecord, expected: AgentProfileAuthorityRecord): Promise<void>;
  retire(agentName: string, expected: AgentProfileAuthorityRecord): Promise<void>;
  move?(
    oldAgentName: string,
    newAgentName: string,
    expected: AgentProfileAuthorityRecord,
    target: AgentProfileAuthorityRecord,
  ): Promise<void>;
}

export function agentProfileTransactionsRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), AGENT_PROFILE_TRANSACTIONS_REL);
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function requireSafeDirectory(workspaceRoot: string, directory: string): void {
  const workspaceReal = fs.realpathSync.native(path.resolve(workspaceRoot));
  const expected = path.join(workspaceReal, path.relative(path.resolve(workspaceRoot), directory));
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== expected) {
    throw new Error(`unsafe agent profile transaction directory: ${directory}`);
  }
}

function ensureSafeDirectory(workspaceRoot: string, directory: string): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  requireSafeDirectory(workspaceRoot, directory);
  syncDirectory(path.dirname(directory));
}

function ensureTransactionsRoot(workspaceRoot: string): string {
  const root = agentProfileTransactionsRoot(workspaceRoot);
  for (const directory of [path.dirname(root), root, path.join(root, "locks")]) {
    try {
      ensureSafeDirectory(workspaceRoot, directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      requireSafeDirectory(workspaceRoot, directory);
    }
  }
  return root;
}

function writeNewDurable(file: string, bytes: string | Buffer): void {
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(file));
}

function transactionLockPath(root: string, agentName: string): string {
  const key = Buffer.from(asciiFoldAgentName(agentName), "utf8").toString("hex");
  return path.join(root, "locks", `${key}.lock`);
}

interface TransactionLockRecord {
  txid: string;
  pid: number;
}

function readTransactionLock(root: string, agentName: string): TransactionLockRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(transactionLockPath(root, agentName), "utf8")) as Partial<TransactionLockRecord>;
    if (typeof value.txid !== "string" || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1) {
      throw new Error(`invalid agent profile transaction lock for '${agentName}'`);
    }
    return value as TransactionLockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireTransactionLock(root: string, agentName: string, txid: string): () => void {
  const file = transactionLockPath(root, agentName);
  const record: TransactionLockRecord = { txid, pid: process.pid };
  try {
    writeNewDurable(file, `${JSON.stringify(record)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`agent profile transaction for '${agentName}' is already active`);
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    const current = readTransactionLock(root, agentName);
    if (!current || current.txid !== txid || current.pid !== process.pid) {
      throw new Error(`agent profile transaction lock changed for '${agentName}'`);
    }
    fs.unlinkSync(file);
    syncDirectory(path.dirname(file));
    released = true;
  };
}

function releaseRecoveredTransactionLock(root: string, agentName: string, txid: string): void {
  const current = readTransactionLock(root, agentName);
  if (!current) return;
  if (current.txid !== txid) throw new Error(`agent profile transaction lock belongs to another transaction for '${agentName}'`);
  if (current.pid !== process.pid && processAlive(current.pid)) {
    throw new Error(`agent profile transaction for '${agentName}' is active in process ${current.pid}`);
  }
  fs.unlinkSync(transactionLockPath(root, agentName));
  syncDirectory(path.join(root, "locks"));
}

export function acquireAgentProfileTransactionLock(
  workspaceRoot: string,
  agentName: string,
  txid: string,
): () => void {
  return acquireTransactionLock(ensureTransactionsRoot(workspaceRoot), agentName, txid);
}

export function acquireAgentProfileTransactionLocks(
  workspaceRoot: string,
  agentNames: readonly string[],
  txid: string,
): () => void {
  const names = [...new Map(agentNames.map((name) => [asciiFoldAgentName(name), name])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, name]) => name);
  const releases: Array<() => void> = [];
  try {
    for (const name of names) releases.push(acquireAgentProfileTransactionLock(workspaceRoot, name, txid));
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const release of releases.reverse()) {
      try { release(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "agent profile transaction lock cleanup failed", { cause: error });
    }
    throw error;
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

export function acquireAgentProfileRecoveryLock(
  workspaceRoot: string,
  agentName: string,
  txid: string,
): () => void {
  const root = ensureTransactionsRoot(workspaceRoot);
  releaseRecoveredTransactionLock(root, agentName, txid);
  return acquireTransactionLock(root, agentName, txid);
}

export function acquireAgentProfileRecoveryLocks(
  workspaceRoot: string,
  agentNames: readonly string[],
  txid: string,
): () => void {
  const names = [...new Map(agentNames.map((name) => [asciiFoldAgentName(name), name])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, name]) => name);
  const releases: Array<() => void> = [];
  try {
    for (const name of names) releases.push(acquireAgentProfileRecoveryLock(workspaceRoot, name, txid));
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const release of releases.reverse()) {
      try { release(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "agent profile recovery lock cleanup failed", { cause: error });
    }
    throw error;
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

/**
 * t-ae221c — the whole `tachyon.yml` read/CAS-replace path that lived here is gone.
 *
 * It existed for exactly one caller: the create/rename/forget transactions writing the agent's
 * pointer stanza as their second durable file. The roster comes from `.tachyon/agents/` now, so no
 * profile transaction touches the config at all — and a whole-file compare-and-swap that nothing
 * calls is a door left standing in a wall that moved.
 */

function descriptorPath(fd: number): string {
  const expected = fs.fstatSync(fd, { bigint: true });
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = `${base}/${fd}`;
    try {
      const actual = fs.statSync(candidate, { bigint: true });
      if (actual.dev === expected.dev && actual.ino === expected.ino) return candidate;
    } catch {
      // Try the next host-supported descriptor filesystem path.
    }
  }
  throw new Error("host has no verified descriptor-relative filesystem path");
}

function openProfileDirectory(workspaceRoot: string, agentName: string): { fd: number; close(): void } {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof directory !== "number" || typeof nonBlock !== "number") {
    throw new Error("host does not support no-follow profile publication");
  }
  const opened: number[] = [];
  try {
    let current = fs.openSync(fs.realpathSync.native(workspaceRoot), fs.constants.O_RDONLY | directory | noFollow | nonBlock);
    opened.push(current);
    for (const segment of [".tachyon", "agents", agentName]) {
      current = fs.openSync(`${descriptorPath(current)}/${segment}`, fs.constants.O_RDONLY | directory | noFollow | nonBlock);
      if (!fs.fstatSync(current).isDirectory()) throw new Error(`profile path component is not a directory: ${segment}`);
      opened.push(current);
    }
    const retained = opened.pop()!;
    return {
      fd: retained,
      close: () => {
        fs.closeSync(retained);
        for (const openedFd of opened.reverse()) fs.closeSync(openedFd);
      },
    };
  } catch (error) {
    for (const openedFd of opened.reverse()) {
      try { fs.closeSync(openedFd); } catch { /* preserve failure */ }
    }
    throw error;
  }
}

export function currentProfileDigest(workspaceRoot: string, agentName: string): string | null {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return null;
  try {
    return source.sha256;
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

export function publishAgentProfile(workspaceRoot: string, agentName: string, profileText: string): void {
  const tachyon = path.join(workspaceRoot, ".tachyon");
  const agents = path.join(tachyon, "agents");
  const principal = path.join(agents, agentName);
  for (const target of [tachyon, agents, principal]) {
    try {
      ensureSafeDirectory(workspaceRoot, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      requireSafeDirectory(workspaceRoot, target);
    }
  }
  const retained = openProfileDirectory(workspaceRoot, agentName);
  try {
    writeNewDurable(`${descriptorPath(retained.fd)}/agent.yml`, profileText);
  } finally {
    retained.close();
  }
}

/**
 * Unpublish a canonical profile the transaction itself published, and take the home with it.
 *
 * The home goes because this is the CREATE branch of compensation: `publishAgentProfile` minted
 * `.tachyon/agents/<name>/` inside the same transaction, so a rollback that leaves it has not put
 * the workspace back the way it found it. `removeEmptyAgentProfileHome` states the policy and the
 * argument for `rmdir` over `rm -rf` — anything the create did not put there survives, and is now
 * reported as `orphan-home` rather than disappearing into `absent` (t-4a1f85, t-8b58b3).
 */
export function removeAgentProfileIfExact(
  workspaceRoot: string,
  agentName: string,
  expectedSha256: string,
): void {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return;
  try {
    if (source.sha256 !== expectedSha256) throw new Error(`canonical profile for '${agentName}' changed outside the transaction`);
    fs.unlinkSync(`${descriptorPath(source.profileDirectoryFd)}/agent.yml`);
    syncDirectory(descriptorPath(source.profileDirectoryFd));
  } finally {
    closeCanonicalAgentProfile(source);
  }
  removeEmptyAgentProfileHome(workspaceRoot, agentName);
}
