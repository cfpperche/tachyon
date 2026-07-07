import fs from "node:fs";
import path from "node:path";
import type { SpawnContract } from "./spawnContract.js";

export interface DelegationGate {
  behaviorTest: string;
  owns?: string[];
}

export interface DelegationRecord {
  agent: string;
  taskId?: string;
  baseSha: string;
  taskRef: string;
  owns: string[];
  behaviorTest: string;
  contract: {
    task: string;
    deliverable?: string;
    doneWhen?: string;
  };
  createdAt: string;
}

export function delegationRecordPath(workspaceRoot: string, agent: string, createdAt: string): string {
  const safeTs = createdAt.replace(/[:.]/g, "-");
  return path.join(workspaceRoot, ".tachyon", "delegations", `${agent}-${safeTs}.json`);
}

export function writeDelegationRecord(workspaceRoot: string, record: DelegationRecord): string {
  const file = delegationRecordPath(workspaceRoot, record.agent, record.createdAt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return file;
}

export function readDelegationRecord(file: string): DelegationRecord {
  return JSON.parse(fs.readFileSync(file, "utf8")) as DelegationRecord;
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

export function delegationRecordFromSpawn(input: {
  agent: string;
  baseSha: string;
  taskRef: string;
  gate: DelegationGate;
  contract: SpawnContract;
  createdAt?: string;
}): DelegationRecord {
  return {
    agent: input.agent,
    baseSha: input.baseSha,
    taskRef: input.taskRef,
    owns: input.gate.owns ?? [],
    behaviorTest: input.gate.behaviorTest,
    contract: {
      task: input.contract.task,
      ...(input.contract.deliverable ? { deliverable: input.contract.deliverable } : {}),
      ...(input.contract.doneWhen ? { doneWhen: input.contract.doneWhen } : {}),
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
