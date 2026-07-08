import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SpawnContract } from "./spawnContract.js";

export interface DelegationGate {
  behaviorTest: string;
  owns?: string[];
  stubPath?: string;
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
  /** spec 363 T2 — container-generated canonical behavior test stub the agent must edit without renaming. */
  stubPath?: string;
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
}

export function delegationRecordPath(workspaceRoot: string, agent: string, createdAt: string): string {
  const safeTs = createdAt.replace(/[:.]/g, "-");
  return path.join(workspaceRoot, ".tachyon", "delegations", `${agent}-${safeTs}.json`);
}

export function writeDelegationRecord(workspaceRoot: string, record: DelegationRecord): string {
  const file = delegationRecordPath(workspaceRoot, record.agent, record.createdAt);
  const persisted = record.worktreePath ? record : { ...record, ...worktreePathForTaskRef(workspaceRoot, record.taskRef) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  return file;
}

export function readDelegationRecord(file: string): DelegationRecord {
  return JSON.parse(fs.readFileSync(file, "utf8")) as DelegationRecord;
}

function worktreePathForTaskRef(workspaceRoot: string, taskRef: string): { worktreePath?: string } {
  try {
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: workspaceRoot, encoding: "utf8" });
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
export function archiveDelegationRecord(file: string): DelegationRecord {
  const updated: DelegationRecord = { ...readDelegationRecord(file), archived: true };
  fs.writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

/** t-815796 design point 4/5 — append one reuse_worktree grant to the ORIGINAL delegation record (never
 *  mutates baseSha/behaviorTest/owns, which verify_task keeps binding to). */
export function appendFixerAttempt(file: string, attempt: FixerAttempt): DelegationRecord {
  const record = readDelegationRecord(file);
  const updated: DelegationRecord = { ...record, fixerAttempts: [...(record.fixerAttempts ?? []), attempt] };
  fs.writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

export function delegationRecordFromSpawn(input: {
  agent: string;
  delegator?: string;
  baseSha: string;
  taskRef: string;
  gate: DelegationGate;
  stubPath?: string;
  contract: SpawnContract;
  createdAt?: string;
  id?: string;
  worktreePath?: string;
}): DelegationRecord {
  const owns = input.gate.owns ?? [];
  return {
    id: input.id ?? crypto.randomUUID(),
    agent: input.agent,
    ...(input.delegator ? { delegator: input.delegator } : {}),
    baseSha: input.baseSha,
    taskRef: input.taskRef,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    owns: input.stubPath && !owns.includes(input.stubPath) ? [...owns, input.stubPath] : owns,
    behaviorTest: input.gate.behaviorTest,
    ...(input.stubPath ? { stubPath: input.stubPath } : {}),
    contract: {
      task: input.contract.task,
      ...(input.contract.deliverable ? { deliverable: input.contract.deliverable } : {}),
      ...(input.contract.doneWhen ? { doneWhen: input.contract.doneWhen } : {}),
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
