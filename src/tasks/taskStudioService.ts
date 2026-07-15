import fs from "node:fs";
import {
  decodeTaskStudioBase64,
  type TaskStudioImagePayloadV1,
  type TaskStudioPatchV1,
  type TaskStudioPrototypePayloadV1,
  type TaskStudioSketchPayloadV1,
} from "../runtime-api/taskStudioCommands.js";
import type { RichDocAttachment } from "../richDoc/types.js";
import { docToMarkdown } from "./docMarkdown.js";
import { TaskAttachmentStore, TASK_BLOB_SOFT_LIMIT_BYTES } from "./TaskAttachmentStore.js";
import { TaskDetailStore, hashBody, type TaskDetail } from "./TaskDetailStore.js";
import { TaskPrototypeStore } from "./TaskPrototypeStore.js";
import type { TaskStore } from "./TaskStore.js";
import type { Task } from "./types.js";
import { composeDirtyPatch, isEmptyPatch } from "./studioModel.js";

export type TaskStudioSaveServiceResult =
  | { status: "ok" }
  | { status: "conflict"; message: string }
  | { status: "error"; code: string; message: string };

export interface TaskStudioAttachmentServiceResult {
  attachment: RichDocAttachment;
  overSoftLimit: boolean;
}

export async function saveTaskStudio(
  workspaceRoot: string,
  taskStore: TaskStore,
  taskId: string,
  patch: TaskStudioPatchV1,
): Promise<TaskStudioSaveServiceResult> {
  const detailStore = new TaskDetailStore(workspaceRoot);
  return patch.expectUpdatedAt === undefined
    ? saveStaged(workspaceRoot, taskStore, taskId, patch, detailStore)
    : saveUpdate(taskStore, taskId, patch, detailStore);
}

export function cancelTaskStudio(workspaceRoot: string, taskStore: TaskStore, taskId: string): void {
  try {
    taskStore.get(taskId);
    return;
  } catch {
    // A pre-minted task that still does not exist owns only provisional artifacts.
  }
  try {
    fs.rmSync(new TaskAttachmentStore(workspaceRoot, taskId).taskAttachmentsDir, { recursive: true, force: true });
  } catch {
    // Cancellation cleanup remains best-effort, matching the legacy panel contract.
  }
}

export function putTaskStudioImage(
  workspaceRoot: string,
  taskId: string,
  payload: TaskStudioImagePayloadV1,
): TaskStudioAttachmentServiceResult {
  const store = new TaskAttachmentStore(workspaceRoot, taskId);
  const attachment = store.putImage({
    data: decodeTaskStudioBase64(payload.dataBase64, "task image"),
    mediaType: payload.mediaType,
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    source: payload.source,
  });
  return { attachment, overSoftLimit: store.totalBlobBytes() > TASK_BLOB_SOFT_LIMIT_BYTES };
}

export function putTaskStudioSketch(
  workspaceRoot: string,
  taskId: string,
  payload: TaskStudioSketchPayloadV1,
): TaskStudioAttachmentServiceResult {
  const store = new TaskAttachmentStore(workspaceRoot, taskId);
  const current = new TaskDetailStore(workspaceRoot).read(taskId);
  const existing = current.status === "ok"
    ? current.detail.attachments.find((attachment) => attachment.kind === "excalidraw" && attachment.id === payload.attachmentId)
    : undefined;
  const attachment = store.putExcalidraw({
    sceneJson: payload.sceneJson,
    previewData: decodeTaskStudioBase64(payload.previewBase64, "task sketch preview"),
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    source: payload.source,
    ...(payload.baseImageAttachmentId !== undefined ? { baseImageAttachmentId: payload.baseImageAttachmentId } : {}),
    ...(existing?.kind === "excalidraw" ? { existing } : {}),
  });
  return { attachment, overSoftLimit: store.totalBlobBytes() > TASK_BLOB_SOFT_LIMIT_BYTES };
}

export function importTaskStudioPrototype(
  workspaceRoot: string,
  taskId: string,
  payload: TaskStudioPrototypePayloadV1,
): void {
  new TaskPrototypeStore(workspaceRoot, taskId).createDraft({
    html: payload.html,
    title: payload.title,
    author: "human",
  });
}

async function saveStaged(
  workspaceRoot: string,
  taskStore: TaskStore,
  taskId: string,
  patch: TaskStudioPatchV1,
  detailStore: TaskDetailStore,
): Promise<TaskStudioSaveServiceResult> {
  try {
    await detailStore.createStaged(taskStore, taskId, {
      title: patch.title,
      ...(patch.kind ? { kind: patch.kind } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.artifact_refs.length ? { artifact_refs: patch.artifact_refs } : {}),
      ...(patch.deps.length ? { deps: patch.deps } : {}),
      doc: patch.doc,
      attachments: patch.attachments,
      body: docToMarkdown(patch.doc),
    });
    return { status: "ok" };
  } catch (error) {
    try {
      fs.rmSync(new TaskAttachmentStore(workspaceRoot, taskId).taskAttachmentsDir, { recursive: true, force: true });
    } catch {
      // Preserve the legacy best-effort failure cleanup.
    }
    return { status: "error", code: "STAGED_CREATE_FAILED", message: errorMessage(error) };
  }
}

async function saveUpdate(
  taskStore: TaskStore,
  taskId: string,
  patch: TaskStudioPatchV1,
  detailStore: TaskDetailStore,
): Promise<TaskStudioSaveServiceResult> {
  try {
    const previousRead = detailStore.read(taskId);
    const previousAttachments = previousRead.status === "ok" ? previousRead.detail.attachments : [];
    const nextBody = docToMarkdown(patch.doc);
    const bodyChanged = patch.bodyBaseline === undefined ? patch.docDirty : nextBody !== patch.bodyBaseline;
    const body = bodyChanged ? nextBody : undefined;
    const composed = composeDirtyPatch(
      {
        title: patch.title,
        kind: patch.kind ?? null,
        priority: patch.priority ?? null,
        assignee: patch.assignee ?? null,
        deps: patch.deps.length ? patch.deps : null,
        artifact_refs: patch.artifact_refs.length ? patch.artifact_refs : null,
      },
      patch.dirty,
      {
        ...(body !== undefined ? { body: body.trim() ? body : null } : {}),
        expectUpdatedAt: patch.expectUpdatedAt!,
      },
    );
    if (isEmptyPatch(composed)) return { status: "ok" };

    let updated: Task;
    try {
      updated = await taskStore.update(taskId, composed);
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith("precondition-failed")) return { status: "conflict", message };
      throw error;
    }
    if (body !== undefined) {
      const detail: TaskDetail = {
        schemaVersion: 1,
        taskId,
        doc: patch.doc,
        attachments: patch.attachments,
        bodyHash: hashBody(body),
        taskUpdatedAt: updated.updatedAt,
      };
      detailStore.write(detail);
      detailStore.gcRemovedAttachments(taskId, previousAttachments, patch.attachments);
    }
    return { status: "ok" };
  } catch (error) {
    return { status: "error", code: "SAVE_FAILED", message: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
