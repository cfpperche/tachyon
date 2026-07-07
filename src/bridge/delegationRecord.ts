import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

export function currentDelegationBaseSha(workspaceRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf8" }).trim();
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
