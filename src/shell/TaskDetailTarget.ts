import { randomUUID } from "node:crypto";
import {
  isMissionControlTaskUpdateInputV1,
  type MissionControlTaskPatchV1,
} from "../runtime-api/missionControlCommands.js";
import {
  isTaskPrototypeReviewInputV1,
  type TaskPrototypeReviewInputV1,
} from "../runtime-api/taskDetailCommands.js";
import {
  projectTaskDetail,
  readTaskDetailPrototypeHtml,
  taskDetailAttachmentBlobPath,
  taskDetailAttachmentBlobRoot,
  type TaskDetailProjectionV1,
} from "../runtime-api/taskDetailProjection.js";
import { reviewTaskPrototype } from "../tasks/taskPrototypeReview.js";
import type { TaskStore } from "../tasks/TaskStore.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";

export type TaskPrototypeReviewActionV1 = Omit<TaskPrototypeReviewInputV1, "taskId">;

export interface WorkspaceTaskDetailTarget extends WorkspacePresentationTarget {
  loadTaskDetail(id: string): Promise<TaskDetailProjectionV1>;
  updateTask(id: string, patch: MissionControlTaskPatchV1): Promise<void>;
  reviewPrototype(taskId: string, input: TaskPrototypeReviewActionV1): Promise<void>;
  attachmentBlobRoot(taskId: string): string;
  attachmentBlobPath(taskId: string, blobRef: string): string;
  prototypeHtml(taskId: string, prototypeId: string): string;
}

export interface LegacyTaskDetailSource extends WorkspacePresentationTarget {
  readonly taskStore: TaskStore;
}

/** Compatibility implementation until extension activation performs the one-time client-registry cutover. */
export function legacyTaskDetailTarget(source: LegacyTaskDetailSource): WorkspaceTaskDetailTarget {
  return {
    workspaceRoot: source.workspaceRoot,
    wsHash: source.wsHash,
    folderName: source.folderName,
    loadTaskDetail: async (id) => projectTaskDetail(source.taskStore, source.workspaceRoot, id),
    updateTask: async (id, patch) => {
      assertTaskDetailUpdate(id, patch);
      await source.taskStore.update(id, patch);
    },
    reviewPrototype: async (taskId, input) => {
      const command = assertPrototypeReview(taskId, input);
      await reviewTaskPrototype(source.workspaceRoot, source.taskStore, command);
    },
    attachmentBlobRoot: (taskId) => taskDetailAttachmentBlobRoot(source.workspaceRoot, taskId),
    attachmentBlobPath: (taskId, blobRef) => taskDetailAttachmentBlobPath(source.workspaceRoot, taskId, blobRef),
    prototypeHtml: (taskId, prototypeId) => readTaskDetailPrototypeHtml(source.workspaceRoot, taskId, prototypeId),
  };
}

export function workspaceTaskDetailTarget(client: WorkspaceClient): WorkspaceTaskDetailTarget {
  const identity = workspacePresentationTarget(client);
  const invoke = async (command: Parameters<WorkspaceClient["invoke"]>[1]): Promise<void> => {
    const result = await client.invoke(`task-detail:${randomUUID()}`, command);
    if (result.status === "error") throw new Error(result.message);
  };
  return {
    ...identity,
    loadTaskDetail: async (id) => {
      const result = await client.query({ schemaVersion: 1, method: "task.detail", input: { id } });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "task.detail") throw new Error("Task Detail query returned the wrong view");
      return result.view.detail;
    },
    updateTask: (id, patch) => {
      assertTaskDetailUpdate(id, patch);
      return invoke({ schemaVersion: 1, method: "task.update", input: { id, patch } });
    },
    reviewPrototype: (taskId, input) => invoke({
      schemaVersion: 1,
      method: "task.prototype.review",
      input: assertPrototypeReview(taskId, input),
    }),
    attachmentBlobRoot: (taskId) => taskDetailAttachmentBlobRoot(identity.workspaceRoot, taskId),
    attachmentBlobPath: (taskId, blobRef) => taskDetailAttachmentBlobPath(identity.workspaceRoot, taskId, blobRef),
    prototypeHtml: (taskId, prototypeId) => readTaskDetailPrototypeHtml(identity.workspaceRoot, taskId, prototypeId),
  };
}

function assertTaskDetailUpdate(id: string, patch: MissionControlTaskPatchV1): void {
  if (!isMissionControlTaskUpdateInputV1({ id, patch })) {
    throw new Error("invalid Task Detail task update");
  }
}

function assertPrototypeReview(
  taskId: string,
  input: TaskPrototypeReviewActionV1,
): TaskPrototypeReviewInputV1 {
  const command: unknown = { taskId, ...input };
  if (!isTaskPrototypeReviewInputV1(command)) throw new Error("invalid Task Detail prototype review");
  return command;
}
