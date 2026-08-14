import { randomUUID } from "node:crypto";
import { approvalResolutionPorts } from "@tachyon/engine/bridge/approvalResolutionPorts.js";
import type { NoticeDeliveryResult } from "@tachyon/engine/bridge/tools.js";
import type { AgentInstanceLifetime } from "@tachyon/engine/resume/SessionLedger.js";
import { buildBoardSnapshot, type BoardSnapshot } from "@tachyon/engine/tasks/boardSnapshot.js";
import type { ReorderLaneInput, TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import type { TaskPriority, TaskStatus } from "@tachyon/shared/tasks/types.js";
import { restoreBoardSnapshot } from "@tachyon/engine/runtime-api/boardProjection.js";
import type { BoardTaskPatchV1 } from "@tachyon/engine/runtime-api/boardCommands.js";
import { EDITOR_HUMAN_ACTOR, type Validation, type ValidationCloseInput, type ValidationUpdateExpect } from "@tachyon/engine/validations/types.js";
import { wakeValidationClosedAuthors, type ValidationCloseLiveEntry } from "@tachyon/engine/validations/validationCloseNotify.js";
import { ValidationStore } from "@tachyon/engine/validations/ValidationStore.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";
import { isAgentRow } from "@tachyon/shared/sidebar/types.js";

export interface BoardAgentRow {
  name: string;
  kind: "agent" | "terminal";
  running: boolean;
  lifetime: AgentInstanceLifetime;
}

export interface WorkspaceBoardTarget extends WorkspacePresentationTarget {
  declaredAgentNames(): string[];
  listBoardAgents(): Promise<BoardAgentRow[]>;
  boardSnapshot(liveTemporaryAgents: string[]): Promise<BoardSnapshot>;
  updateTask(id: string, patch: BoardTaskPatchV1): Promise<void>;
  reorderLane(status: TaskStatus, priority: TaskPriority | undefined, input: Pick<ReorderLaneInput, "orderedIds" | "expect">): Promise<void>;
  closeValidation(id: string, input: Pick<ValidationCloseInput, "outcome"> & { result_note: string }): Promise<void>;
  listValidations(): Validation[];
  assignValidation(id: string, assignee: string, expect?: ValidationUpdateExpect): Promise<void>;
}

export interface LegacyBoardSource extends WorkspacePresentationTarget {
  readonly config?: { agents?: Record<string, unknown> };
  readonly manager: {
    list(): Promise<Array<BoardAgentRow | ValidationCloseLiveEntry>>;
    listAgents(): Promise<Array<BoardAgentRow | ValidationCloseLiveEntry>>;
  };
  readonly taskStore: TaskStore;
  readonly validationStore: ValidationStore;
  /**
   * t-b805b5 — queue-aware wake (full Workspace has this). Same door as approval resolution
   * (`approvalResolutionPorts` / t-d79534): busy authors are enqueued, not typed into mid-turn.
   */
  readonly deliverNotice?: (agent: string, line: string) => Promise<NoticeDeliveryResult>;
  /**
   * t-c6c4ad — optional raw inject fallback when `deliverNotice` is absent (thin fakes).
   * Prefer `deliverNotice` so a busy author is queued instead of receiving a blind submit.
   */
  readonly tmux?: { sendSubmittedLine(session: string, text: string): Promise<unknown> };
}

/** Compatibility adapter used only until extension activation switches to WorkspaceClient. */
export function legacyBoardTarget(source: LegacyBoardSource): WorkspaceBoardTarget {
  return {
    workspaceRoot: source.workspaceRoot,
    wsHash: source.wsHash,
    folderName: source.folderName,
    declaredAgentNames: () => Object.keys(source.config?.agents ?? {}),
    listBoardAgents: () => source.manager.listAgents() as Promise<BoardAgentRow[]>,
    boardSnapshot: async (liveTemporaryAgents) => buildBoardSnapshot({
      store: source.taskStore,
      declaredAgents: Object.keys(source.config?.agents ?? {}),
      liveTemporaryAgents,
      validationStore: source.validationStore,
      workspaceRoot: source.workspaceRoot,
    }),
    updateTask: async (id, patch) => { await source.taskStore.update(id, patch); },
    reorderLane: async (status, priority, input) => { await source.taskStore.reorderLane(status, priority, input); },
    // t-98256c — the in-process shell path is the human in the editor, same as the engine command.
    // t-c6c4ad — durable close first; best-effort author wake when the source can inject (Workspace).
    // t-b805b5 — wake through deliverNotice (approval twin), not a bare sendSubmittedLine.
    closeValidation: async (id, input) => {
      const closed = await source.validationStore.closeRound(id, { ...input, actor: EDITOR_HUMAN_ACTOR });
      const listEntries = async () => (await source.manager.list()) as ValidationCloseLiveEntry[];
      if (source.deliverNotice) {
        const ports = approvalResolutionPorts({
          listEntries: async () => (await source.manager.list()) as Array<{ session: string; running: boolean; name: string }>,
          deliverNotice: source.deliverNotice,
        });
        await wakeValidationClosedAuthors({
          validation: closed,
          outcome: input.outcome,
          listEntries,
          inject: ports.inject,
        });
      } else if (source.tmux) {
        await wakeValidationClosedAuthors({
          validation: closed,
          outcome: input.outcome,
          listEntries,
          inject: async (session, text) => {
            await source.tmux!.sendSubmittedLine(session, text);
            return { receipt: `tmux:${session}` };
          },
        });
      }
    },
    listValidations: () => source.validationStore.list(),
    assignValidation: async (id, assignee, expect) => { await source.validationStore.update(id, { actor: EDITOR_HUMAN_ACTOR, assignee, ...(expect ? { expect } : {}) }); },
  };
}

export function workspaceBoardTarget(client: WorkspaceClient): WorkspaceBoardTarget {
  const identity = workspacePresentationTarget(client);
  const invoke = async (command: Parameters<WorkspaceClient["invoke"]>[1]): Promise<void> => {
    const result = await client.invoke(`board:${randomUUID()}`, command);
    if (result.status === "error") throw new Error(result.message);
  };
  return {
    ...identity,
    declaredAgentNames: () => client.presentation.agents.items.filter((agent) => agent.lifetime === "saved").map((agent) => agent.name),
    listBoardAgents: async () => {
      const agents = client.presentation.agents;
      if (agents.truncated) throw new Error("Board agent projection is truncated");
      return agents.items.filter(isAgentRow).map((agent) => ({
        name: agent.name,
        kind: agent.kind,
        running: agent.running,
        lifetime: agent.lifetime,
      }));
    },
    boardSnapshot: async (liveTemporaryAgents) => {
      const result = await client.query({ schemaVersion: 1, method: "task.board", input: { liveTemporaryAgents } });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "task.board") throw new Error("Board query returned the wrong view");
      return restoreBoardSnapshot(result.view.board);
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
