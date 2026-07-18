import { randomUUID } from "node:crypto";
import { buildBoardSnapshot, type BoardSnapshot } from "../tasks/boardSnapshot.js";
import type { ReorderLaneInput, TaskStore } from "../tasks/TaskStore.js";
import type { TaskPriority, TaskStatus } from "../tasks/types.js";
import { missionControlBoardSnapshot } from "../runtime-api/missionControlProjection.js";
import type { MissionControlTaskPatchV1 } from "../runtime-api/missionControlCommands.js";
import type { Validation, ValidationCloseInput, ValidationUpdateExpect } from "../validations/types.js";
import { ValidationStore } from "../validations/ValidationStore.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";

export interface MissionControlAgentRow {
  name: string;
  kind: "agent" | "terminal";
  running: boolean;
  declared: boolean;
}

export interface WorkspaceMissionControlTarget extends WorkspacePresentationTarget {
  declaredAgentNames(): string[];
  listMissionControlAgents(): Promise<MissionControlAgentRow[]>;
  boardSnapshot(liveAdhocAgents: string[]): Promise<BoardSnapshot>;
  updateTask(id: string, patch: MissionControlTaskPatchV1): Promise<void>;
  reorderLane(status: TaskStatus, priority: TaskPriority | undefined, input: Pick<ReorderLaneInput, "orderedIds" | "expect">): Promise<void>;
  closeValidation(id: string, input: Pick<ValidationCloseInput, "outcome"> & { result_note: string }): Promise<void>;
  listValidations(): Validation[];
  assignValidation(id: string, assignee: string, expect?: ValidationUpdateExpect): Promise<void>;
}

export interface LegacyMissionControlSource extends WorkspacePresentationTarget {
  readonly config?: { agents?: Record<string, unknown> };
  readonly manager: { list(): Promise<MissionControlAgentRow[]> };
  readonly taskStore: TaskStore;
  readonly validationStore: ValidationStore;
}

/** Compatibility adapter used only until extension activation switches to WorkspaceClient. */
export function legacyMissionControlTarget(source: LegacyMissionControlSource): WorkspaceMissionControlTarget {
  return {
    workspaceRoot: source.workspaceRoot,
    wsHash: source.wsHash,
    folderName: source.folderName,
    declaredAgentNames: () => Object.keys(source.config?.agents ?? {}),
    listMissionControlAgents: () => source.manager.list(),
    boardSnapshot: async (liveAdhocAgents) => buildBoardSnapshot({
      store: source.taskStore,
      declaredAgents: Object.keys(source.config?.agents ?? {}),
      liveAdhocAgents,
      validationStore: source.validationStore,
      workspaceRoot: source.workspaceRoot,
    }),
    updateTask: async (id, patch) => { await source.taskStore.update(id, patch); },
    reorderLane: async (status, priority, input) => { await source.taskStore.reorderLane(status, priority, input); },
    closeValidation: async (id, input) => { await source.validationStore.closeRound(id, input); },
    listValidations: () => source.validationStore.list(),
    assignValidation: async (id, assignee, expect) => { await source.validationStore.update(id, { assignee, ...(expect ? { expect } : {}) }); },
  };
}

export function workspaceMissionControlTarget(client: WorkspaceClient): WorkspaceMissionControlTarget {
  const identity = workspacePresentationTarget(client);
  const invoke = async (command: Parameters<WorkspaceClient["invoke"]>[1]): Promise<void> => {
    const result = await client.invoke(`mission-control:${randomUUID()}`, command);
    if (result.status === "error") throw new Error(result.message);
  };
  return {
    ...identity,
    declaredAgentNames: () => client.presentation.agents.items.filter((agent) => agent.declared).map((agent) => agent.name),
    listMissionControlAgents: async () => {
      const agents = client.presentation.agents;
      if (agents.truncated) throw new Error("Mission Control agent projection is truncated");
      return agents.items.map((agent) => ({
        name: agent.name,
        kind: agent.kind,
        running: agent.running,
        declared: agent.declared,
      }));
    },
    boardSnapshot: async (liveAdhocAgents) => {
      const result = await client.query({ schemaVersion: 1, method: "task.board", input: { liveAdhocAgents } });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "task.board") throw new Error("Mission Control query returned the wrong view");
      return missionControlBoardSnapshot(result.view.board);
    },
    updateTask: (id, patch) => invoke({ schemaVersion: 1, method: "task.update", input: { id, patch } }),
    reorderLane: (status, priority, input) => invoke({
      schemaVersion: 1,
      method: "task.reorder-lane",
      input: { status, ...(priority !== undefined ? { priority } : {}), orderedIds: input.orderedIds, expect: input.expect },
    }),
    closeValidation: (id, input) => invoke({
      schemaVersion: 1,
      method: "validation.close",
      input: { id, outcome: input.outcome, result_note: input.result_note },
    }),
    listValidations: () => new ValidationStore(client.workspaceRoot).list(),
    assignValidation: (id, assignee, expect) => invoke({
      schemaVersion: 1,
      method: "validation.assign",
      input: { id, assignee, ...(expect ? { expect } : {}) },
    }),
  };
}
