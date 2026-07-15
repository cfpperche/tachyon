import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { SpawnContract } from "./spawnContract.js";
import type { TachyonConfig } from "../config/loadConfig.js";
import {
  sealAuthorityRecord,
  verifyAuthorityRecord,
  workspaceAuthorityDomain,
  authorityRecordMac,
  type AuthorityHeadPort,
  type AuthorityIntegrity,
} from "../delivery/authorityIntegrity.js";

const execFileP = promisify(execFile);

export interface DelegationGate {
  behaviorTest: string;
  owns?: string[];
  stubPath?: string;
  /** SHA-256 of the fixed, project-owned behavior oracle bytes bound at spawn. */
  oracleHash?: string;
  /** SHA-256 by tracked project path for the fixed verifier mechanics bound at spawn. */
  executorHashes?: Record<string, string>;
}

/** t-815796 design point 4 — one reuse_worktree grant against this delegation's worktree. Recorded
 *  on the ORIGINAL DelegationRecord (never rewrites baseSha/behaviorTest/owns, which verify_task keeps
 *  binding to) so authority + head provenance for every fixer round survive alongside it. */
export interface FixerAttempt {
  occupantAgent: string;
  requestedOwnsSubset: string[];
  grantedAt: string;
  /** design point 5 — the branch HEAD the grant was made against (head-pinning provenance). */
  branchHeadAtGrant: string;
}

export interface DelegationRecord {
  /** t-815796 — the reuse_worktree API key: stable identity for THIS delegation, independent of the
   *  agent's display name (which can be renamed/respawned/reused for something else). Optional so a
   *  pre-t-815796 record on disk still parses; a freshly-written record always gets one. */
  id?: string;
  agent: string;
  /** Bridge-resolved agent that requested the gated delegation. Distinct from declaredOwner config metadata. */
  delegator?: string;
  taskId?: string;
  baseSha: string;
  taskRef: string;
  /** t-a9d850 — durable path to the isolated task worktree. Optional so legacy records still load. */
  worktreePath?: string;
  owns: string[];
  behaviorTest: string;
  /** spec 363/385 — project-configured named-test stub; absent for runner-neutral `cmd:` verifiers. */
  stubPath?: string;
  /** SHA-256 of the fixed project-owned named-test oracle; absent for cmd: and legacy records. */
  oracleHash?: string;
  /** Tracked verifier-mechanic hashes captured with the named oracle; absent for cmd: and legacy records. */
  executorHashes?: Record<string, string>;
  /** Project verification mechanics captured at spawn; verification does not re-read mutable root config. */
  verifySettings?: TachyonConfig["settings"]["verify"];
  contract: {
    task: string;
    deliverable?: string;
    doneWhen?: string;
  };
  createdAt: string;
  /** t-815796 — excluded from agent-name sugar resolution (resolveReuseTarget); a delegation superseded
   *  or explicitly retired stays on disk for audit but never resolves ambiguously against a live one. */
  archived?: boolean;
  /** t-815796 design point 4 — one entry per reuse_worktree grant against this delegation's worktree. */
  fixerAttempts?: FixerAttempt[];
  /** Host-authenticated seal over the full legacy authority record, including fixer history. */
  authorityIntegrity?: AuthorityIntegrity;
}

export function delegationRecordPath(workspaceRoot: string, agent: string, createdAt: string): string {
  const safeTs = createdAt.replace(/[:.]/g, "-");
  return path.join(workspaceRoot, ".tachyon", "delegations", `${agent}-${safeTs}.json`);
}

export function writeDelegationRecord(workspaceRoot: string, record: DelegationRecord, authorityKey?: Buffer): string {
  const file = delegationRecordPath(workspaceRoot, record.agent, record.createdAt);
  const persisted = authorityKey
    ? sealAuthorityRecord(
      record as DelegationRecord & Record<string, unknown>,
      authorityKey,
      workspaceAuthorityDomain("legacy-delegation", workspaceRoot),
    )
    : record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRecordAtomically(file, persisted);
  return file;
}

export async function writeDelegationRecordAsync(
  workspaceRoot: string,
  record: DelegationRecord,
  authorityKey?: Buffer,
  authorityHead?: AuthorityHeadPort,
): Promise<string> {
  const withWorktree = record.worktreePath ? record : { ...record, ...(await worktreePathForTaskRef(workspaceRoot, record.taskRef)) };
  if (!authorityKey) return writeDelegationRecord(workspaceRoot, withWorktree);
  if (!authorityHead) throw new Error("host-custodied delegation authority head is required");
  const persisted = sealAuthorityRecord(
    withWorktree as DelegationRecord & Record<string, unknown>,
    authorityKey,
    workspaceAuthorityDomain("legacy-delegation", workspaceRoot),
  );
  const identity = delegationAuthorityIdentity(persisted);
  const mac = authorityRecordMac(persisted as DelegationRecord & Record<string, unknown>);
  if (!mac) throw new Error("sealed delegation record has no valid authority MAC");
  await authorityHead.prepare(identity, { revision: 1, mac });
  const file = delegationRecordPath(workspaceRoot, persisted.agent, persisted.createdAt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRecordAtomically(file, persisted);
  return file;
}

export function verifyDelegationRecordAuthority(record: DelegationRecord, authorityKey: Buffer, workspaceRoot: string): boolean {
  return verifyAuthorityRecord(
    record as DelegationRecord & Record<string, unknown>,
    authorityKey,
    workspaceAuthorityDomain("legacy-delegation", workspaceRoot),
  );
}

export function delegationAuthorityIdentity(record: DelegationRecord): string {
  if (!record.id || typeof record.id !== "string") throw new Error("delegation authority identity is missing");
  return record.id;
}

export function verifyDelegationRecordLocation(workspaceRoot: string, file: string, record: DelegationRecord): boolean {
  if (!record.agent || !record.createdAt) return false;
  return path.resolve(file) === path.resolve(delegationRecordPath(workspaceRoot, record.agent, record.createdAt));
}

export async function verifyDelegationRecordFreshness(record: DelegationRecord, authorityHead: AuthorityHeadPort): Promise<boolean> {
  let identity: string;
  try { identity = delegationAuthorityIdentity(record); } catch { return false; }
  const mac = authorityRecordMac(record as DelegationRecord & Record<string, unknown>);
  const head = await authorityHead.current(identity);
  return !!mac && !!head && head.mac === mac && Number.isSafeInteger(head.revision) && head.revision > 0;
}

export function readDelegationRecord(file: string): DelegationRecord {
  return JSON.parse(fs.readFileSync(file, "utf8")) as DelegationRecord;
}

async function worktreePathForTaskRef(workspaceRoot: string, taskRef: string): Promise<{ worktreePath?: string }> {
  try {
    const { stdout: list } = await execFileP("git", ["worktree", "list", "--porcelain"], { cwd: workspaceRoot, encoding: "utf8" });
    let currentPath: string | undefined;
    for (const line of list.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        const branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        if (branch === taskRef && currentPath) return { worktreePath: currentPath };
      }
    }
  } catch {
    // Non-git/unit-test workspaces keep explicit or legacy records unchanged.
  }
  return {};
}

export function latestDelegationRecordPath(workspaceRoot: string, agent: string): string | undefined {
  const dir = path.join(workspaceRoot, ".tachyon", "delegations");
  if (!fs.existsSync(dir)) return undefined;
  const prefix = `${agent}-`;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

export function readLatestDelegationRecord(workspaceRoot: string, agent: string): { path: string; record: DelegationRecord } | undefined {
  const file = latestDelegationRecordPath(workspaceRoot, agent);
  return file ? { path: file, record: readDelegationRecord(file) } : undefined;
}

/** t-815796 — every delegation record on disk, across all agents. Used to resolve reuse_worktree's
 *  delegation id / agent-name sugar; empty (never throws) when the workspace has none yet. */
export function listDelegationRecords(workspaceRoot: string): Array<{ path: string; record: DelegationRecord }> {
  const dir = path.join(workspaceRoot, ".tachyon", "delegations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .map((p) => ({ path: p, record: readDelegationRecord(p) }));
}

/** t-815796 design point 1 — resolve reuse_worktree's primary key: the delegation id, not the agent name. */
export function findDelegationRecordById(workspaceRoot: string, id: string): { path: string; record: DelegationRecord } | undefined {
  return listDelegationRecords(workspaceRoot).find(({ record }) => record.id === id);
}

/** t-815796 design point 1 — agent-name sugar's candidate set: every non-archived delegation for that
 *  agent name. The caller must resolve this to EXACTLY ONE match or refuse AMBIGUOUS_REUSE_TARGET. */
export function findNonArchivedDelegationRecordsByAgent(workspaceRoot: string, agent: string): Array<{ path: string; record: DelegationRecord }> {
  return listDelegationRecords(workspaceRoot).filter(({ record }) => record.agent === agent && !record.archived);
}

/** t-815796 — mark a delegation record archived so it drops out of agent-name sugar resolution. */
export function archiveDelegationRecord(file: string, authorityKey?: Buffer): DelegationRecord {
  if (authorityKey) {
    throw new Error("host-authenticated archive requires archiveDelegationRecordAsync with a freshness head");
  }
  const current = readDelegationRecord(file);
  if (current.authorityIntegrity) throw new Error("sealed delegation mutation requires the host authority key");
  const updated: DelegationRecord = { ...current, archived: true };
  writeRecordAtomically(file, updated);
  return updated;
}

export async function archiveDelegationRecordAsync(
  workspaceRoot: string,
  file: string,
  authorityKey: Buffer,
  authorityHead: AuthorityHeadPort,
): Promise<DelegationRecord> {
  const current = readDelegationRecord(file);
  if (!verifyDelegationRecordLocation(workspaceRoot, file, current)
    || !verifyDelegationRecordAuthority(current, authorityKey, workspaceRoot)
    || !await verifyDelegationRecordFreshness(current, authorityHead)) {
    throw new Error("delegation authority is unsigned, stale, tampered, or misplaced before archive");
  }
  const identity = delegationAuthorityIdentity(current);
  const priorHead = (await authorityHead.current(identity))!;
  const priorMac = authorityRecordMac(current as DelegationRecord & Record<string, unknown>)!;
  const persisted = sealAuthorityRecord(
    { ...current, archived: true } as DelegationRecord & Record<string, unknown>,
    authorityKey,
    workspaceAuthorityDomain("legacy-delegation", workspaceRoot),
  );
  const nextMac = authorityRecordMac(persisted as DelegationRecord & Record<string, unknown>)!;
  await authorityHead.prepare(identity, { revision: priorHead.revision + 1, mac: nextMac }, priorMac);
  writeRecordAtomically(file, persisted);
  return persisted;
}

/** t-815796 design point 4/5 — append one reuse_worktree grant to the ORIGINAL delegation record (never
 *  mutates baseSha/behaviorTest/owns, which verify_task keeps binding to). */
export function appendFixerAttempt(file: string, attempt: FixerAttempt, authorityKey?: Buffer): DelegationRecord {
  if (authorityKey) {
    throw new Error("host-authenticated append requires appendFixerAttemptAsync with a freshness head");
  }
  const record = readDelegationRecord(file);
  const updated: DelegationRecord = { ...record, fixerAttempts: [...(record.fixerAttempts ?? []), attempt] };
  if (record.authorityIntegrity) throw new Error("sealed delegation mutation requires the host authority key");
  writeRecordAtomically(file, updated);
  return updated;
}

/** Production mutation path: authenticate location + current MAC/head, prepare the next SecretStorage
 * head, then atomically replace the workspace record. A crash between those last two steps fails
 * closed (head ahead of file) and can never make an older signed record current again. */
export async function appendFixerAttemptAsync(
  workspaceRoot: string,
  file: string,
  attempt: FixerAttempt,
  authorityKey: Buffer,
  authorityHead: AuthorityHeadPort,
): Promise<DelegationRecord> {
  const record = readDelegationRecord(file);
  if (!verifyDelegationRecordLocation(workspaceRoot, file, record)) {
    throw new Error("delegation record path does not match its authenticated identity");
  }
  if (!verifyDelegationRecordAuthority(record, authorityKey, workspaceRoot) || !await verifyDelegationRecordFreshness(record, authorityHead)) {
    throw new Error("delegation authority is unsigned, stale, or tampered before fixer-attempt append");
  }
  const identity = delegationAuthorityIdentity(record);
  const priorMac = authorityRecordMac(record as DelegationRecord & Record<string, unknown>)!;
  const priorHead = (await authorityHead.current(identity))!;
  const updated: DelegationRecord = { ...record, fixerAttempts: [...(record.fixerAttempts ?? []), attempt] };
  const persisted = sealAuthorityRecord(
    updated as DelegationRecord & Record<string, unknown>,
    authorityKey,
    workspaceAuthorityDomain("legacy-delegation", workspaceRoot),
  );
  const nextMac = authorityRecordMac(persisted as DelegationRecord & Record<string, unknown>);
  if (!nextMac) throw new Error("updated delegation record has no valid authority MAC");
  await authorityHead.prepare(identity, { revision: priorHead.revision + 1, mac: nextMac }, priorMac);
  writeRecordAtomically(file, persisted);
  return persisted;
}

function writeRecordAtomically(file: string, record: DelegationRecord): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    // Persist the directory entry after the SecretStorage head was prepared. If this fails, callers
    // receive a fail-closed recovery error; they never treat an un-fsynced rename as committed.
    let dirFd: number | undefined;
    try {
      dirFd = fs.openSync(path.dirname(file), "r");
      fs.fsyncSync(dirFd);
    } finally {
      if (dirFd !== undefined) fs.closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* primary write error wins */ }
    try { fs.unlinkSync(tmp); } catch { /* rename already consumed it, or creation failed */ }
  }
}

export function delegationRecordFromSpawn(input: {
  agent: string;
  delegator?: string;
  baseSha: string;
  taskRef: string;
  gate: DelegationGate;
  stubPath?: string;
  oracleHash?: string;
  executorHashes?: Record<string, string>;
  contract: SpawnContract;
  createdAt?: string;
  id?: string;
  worktreePath?: string;
  verifySettings?: TachyonConfig["settings"]["verify"];
}): DelegationRecord {
  const owns = input.gate.owns ?? [];
  return {
    id: input.id ?? crypto.randomUUID(),
    agent: input.agent,
    ...(input.delegator ? { delegator: input.delegator } : {}),
    baseSha: input.baseSha,
    taskRef: input.taskRef,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    owns,
    behaviorTest: input.gate.behaviorTest,
    ...(input.stubPath ? { stubPath: input.stubPath } : {}),
    ...(input.oracleHash ? { oracleHash: input.oracleHash } : {}),
    ...(input.executorHashes ? { executorHashes: structuredClone(input.executorHashes) } : {}),
    ...(input.verifySettings ? { verifySettings: structuredClone(input.verifySettings) } : {}),
    contract: {
      task: input.contract.task,
      ...(input.contract.deliverable ? { deliverable: input.contract.deliverable } : {}),
      ...(input.contract.doneWhen ? { doneWhen: input.contract.doneWhen } : {}),
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
