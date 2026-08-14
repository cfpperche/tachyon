import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { RichDocAttachment } from "@tachyon/shared/richDoc/types.js";
import {
  encodeTaskStudioStagedPayloadV1,
  parseTaskStudioStagedPayloadV1,
  type TaskStudioApplyActionV1,
  type TaskStudioImagePayloadV1,
  type TaskStudioPrototypePayloadV1,
  type TaskStudioSketchPayloadV1,
  type TaskStudioStagedPayloadV1,
} from "@tachyon/engine/runtime-api/taskStudioCommands.js";
import {
  projectTaskStudio,
  type TaskStudioProjectionV1,
} from "@tachyon/engine/runtime-api/taskStudioProjection.js";
import { TaskAttachmentStore } from "@tachyon/engine/tasks/TaskAttachmentStore.js";
import {
  cancelTaskStudio,
  importTaskStudioPrototype,
  putTaskStudioImage,
  putTaskStudioSketch,
  saveTaskStudio,
} from "@tachyon/engine/tasks/taskStudioService.js";
import { TaskPrototypeStore } from "@tachyon/engine/tasks/TaskPrototypeStore.js";
import type { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import type { StudioSaveResult } from "@tachyon/engine/webview/shared/studio/adapter.js";
import { assembleUntrustedSrcdoc } from "@tachyon/shared/webview/shared/untrustedSrcdoc.js";
import type { RichDocAttachmentVM } from "@tachyon/webview-ui/webview/rich-doc/types";
import type { TaskDetailEntity, TaskPatch } from "@tachyon/webview-ui/webview/task-studio/domain";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";

export interface TaskStudioImageInput {
  data: Buffer;
  mediaType: string;
  name?: string;
  source: "paste" | "drop" | "import";
}

export interface TaskStudioSketchInput {
  attachmentId?: string;
  name?: string;
  source: "blank" | "annotate-image";
  baseImageAttachmentId?: string;
  sceneJson: string;
  previewData: Buffer;
}

export interface TaskStudioAttachmentResult {
  attachment: RichDocAttachmentVM;
  overSoftLimit: boolean;
}

export interface WorkspaceTaskStudioTarget extends WorkspacePresentationTarget {
  declaredAgentNames(): string[];
  loadTaskStudio(taskId?: string): Promise<TaskDetailEntity>;
  saveTaskStudio(taskId: string, patch: TaskPatch): Promise<StudioSaveResult>;
  cancelTaskStudio(taskId: string): Promise<void>;
  putTaskStudioImage(taskId: string, input: TaskStudioImageInput): Promise<TaskStudioAttachmentResult>;
  putTaskStudioSketch(taskId: string, input: TaskStudioSketchInput): Promise<TaskStudioAttachmentResult>;
  importTaskStudioPrototype(taskId: string, input: { html: string; title: string }): Promise<void>;
}

export interface LegacyTaskStudioSource extends WorkspacePresentationTarget {
  readonly config?: { agents?: Record<string, unknown> };
  readonly taskStore: TaskStore;
}

/** Compatibility target until activation performs the one-time WorkspaceClient registry cutover. */
export function legacyTaskStudioTarget(source: LegacyTaskStudioSource): WorkspaceTaskStudioTarget {
  const load = async (taskId?: string): Promise<TaskDetailEntity> => {
    if (!taskId) return emptyEntity(source, Object.keys(source.config?.agents ?? {}));
    return hydrateProjection(source, projectTaskStudio(source.taskStore, source.workspaceRoot, taskId), Object.keys(source.config?.agents ?? {}));
  };
  return {
    workspaceRoot: source.workspaceRoot,
    wsHash: source.wsHash,
    folderName: source.folderName,
    declaredAgentNames: () => Object.keys(source.config?.agents ?? {}),
    loadTaskStudio: load,
    saveTaskStudio: async (taskId, rawPatch) => {
      const patch = validatePayload("save", { schemaVersion: 1, patch: rawPatch });
      if (!("patch" in patch)) throw new Error("Task Studio save payload has the wrong shape");
      return serviceSaveResult(await saveTaskStudio(source.workspaceRoot, source.taskStore, taskId, patch.patch));
    },
    cancelTaskStudio: async (taskId) => { cancelTaskStudio(source.workspaceRoot, source.taskStore, taskId); },
    putTaskStudioImage: async (taskId, input) => {
      const payload = imagePayload(input);
      const stored = putTaskStudioImage(source.workspaceRoot, taskId, payload);
      return { attachment: hydrateAttachment(source.workspaceRoot, taskId, stored.attachment), overSoftLimit: stored.overSoftLimit };
    },
    putTaskStudioSketch: async (taskId, input) => {
      const payload = sketchPayload(input);
      const stored = putTaskStudioSketch(source.workspaceRoot, taskId, payload);
      return { attachment: hydrateAttachment(source.workspaceRoot, taskId, stored.attachment), overSoftLimit: stored.overSoftLimit };
    },
    importTaskStudioPrototype: async (taskId, input) => {
      importTaskStudioPrototype(source.workspaceRoot, taskId, prototypePayload(input));
    },
  };
}

export function workspaceTaskStudioTarget(client: WorkspaceClient): WorkspaceTaskStudioTarget {
  const identity = workspacePresentationTarget(client);
  const apply = async (
    taskId: string,
    action: TaskStudioApplyActionV1,
    payload: TaskStudioStagedPayloadV1,
  ) => {
    const staged = client.stagePayload(encodeTaskStudioStagedPayloadV1(payload));
    try {
      const result = await client.invoke(`task-studio:${randomUUID()}`, {
        schemaVersion: 1,
        method: "task.studio.apply",
        input: { taskId, action, payload: staged.ref },
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "task.studio.apply" || result.action !== action) {
        throw new Error("persistent engine returned a mismatched Task Studio result");
      }
      return result;
    } finally {
      staged.discard();
    }
  };
  return {
    ...identity,
    declaredAgentNames: () => client.presentation.agents.items.filter((agent) => agent.lifetime === "saved").map((agent) => agent.name),
    loadTaskStudio: async (taskId) => {
      if (!taskId) return emptyEntity(identity, client.presentation.agents.items.filter((agent) => agent.lifetime === "saved").map((agent) => agent.name));
      const result = await client.query({ schemaVersion: 1, method: "task.studio", input: { id: taskId } });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "task.studio") throw new Error("Task Studio query returned the wrong view");
      return hydrateProjection(identity, result.view.studio, client.presentation.agents.items.filter((agent) => agent.lifetime === "saved").map((agent) => agent.name));
    },
    saveTaskStudio: async (taskId, rawPatch) => {
      const payload = validatePayload("save", { schemaVersion: 1, patch: rawPatch });
      const result = await apply(taskId, "save", payload);
      if (result.outcome === "saved") return { status: "ok" };
      if (result.outcome === "conflict") return { status: "conflict", error: { code: "task/precondition-failed", message: result.message! } };
      throw new Error("persistent engine returned a non-save Task Studio outcome");
    },
    cancelTaskStudio: async (taskId) => {
      const result = await client.invoke(`task-studio:${randomUUID()}`, {
        schemaVersion: 1,
        method: "task.studio.cancel",
        input: { taskId },
      });
      if (result.status === "error") throw new Error(result.message);
    },
    putTaskStudioImage: async (taskId, input) => {
      const result = await apply(taskId, "put-image", imagePayload(input));
      if (result.outcome !== "attachment-stored" || result.attachment?.kind !== "image") {
        throw new Error("persistent engine returned a non-image Task Studio outcome");
      }
      return {
        attachment: hydrateAttachment(identity.workspaceRoot, taskId, result.attachment),
        overSoftLimit: result.overSoftLimit!,
      };
    },
    putTaskStudioSketch: async (taskId, input) => {
      const result = await apply(taskId, "put-sketch", sketchPayload(input));
      if (result.outcome !== "attachment-stored" || result.attachment?.kind !== "excalidraw") {
        throw new Error("persistent engine returned a non-sketch Task Studio outcome");
      }
      return {
        attachment: hydrateAttachment(identity.workspaceRoot, taskId, result.attachment),
        overSoftLimit: result.overSoftLimit!,
      };
    },
    importTaskStudioPrototype: async (taskId, input) => {
      const result = await apply(taskId, "import-prototype", prototypePayload(input));
      if (result.outcome !== "prototype-imported") throw new Error("persistent engine returned a non-prototype Task Studio outcome");
    },
  };
}

function hydrateProjection(
  identity: WorkspacePresentationTarget,
  projection: TaskStudioProjectionV1,
  knownAgents: string[],
): TaskDetailEntity {
  const prototypeStore = new TaskPrototypeStore(identity.workspaceRoot, projection.taskId);
  return {
    taskId: projection.taskId,
    workspaceHash: identity.wsHash,
    folder: identity.folderName,
    title: projection.title,
    ...(projection.kind !== undefined ? { kind: projection.kind } : {}),
    ...(projection.priority !== undefined ? { priority: projection.priority } : {}),
    ...(projection.assignee !== undefined ? { assignee: projection.assignee } : {}),
    deps: projection.deps,
    artifact_refs: projection.artifact_refs,
    doc: projection.doc,
    attachments: projection.attachments.map((attachment) => hydrateAttachment(identity.workspaceRoot, projection.taskId, attachment)),
    ...(projection.bodyBaseline !== undefined ? { bodyBaseline: projection.bodyBaseline } : {}),
    anchor: projection.anchor,
    ...(projection.anchorError !== undefined ? { anchorError: projection.anchorError } : {}),
    ...(projection.expectUpdatedAt !== undefined ? { expectUpdatedAt: projection.expectUpdatedAt } : {}),
    knownAgents: [...knownAgents].sort(),
    prototypes: {
      ...(projection.prototypes.updatedAt ? { updatedAt: projection.prototypes.updatedAt } : {}),
      readOnly: projection.prototypes.readOnly,
      ...(projection.prototypes.error ? { error: projection.prototypes.error } : {}),
      prototypes: projection.prototypes.prototypes.map((prototype) => ({
        ...prototype,
        ...(prototype.available
          ? { staticSrcdoc: assembleUntrustedSrcdoc(prototypeStore.readHtml(prototype.id), { mode: "prototype-static" }) }
          : {}),
      })),
    },
  };
}

function hydrateAttachment(workspaceRoot: string, taskId: string, attachment: RichDocAttachment): RichDocAttachmentVM {
  const store = new TaskAttachmentStore(workspaceRoot, taskId);
  const resolved = store.resolveAttachment(attachment);
  if (resolved.kind === "image") {
    let uri: string | undefined;
    if (resolved.available) {
      try { uri = dataUri(resolved.mediaType, fs.readFileSync(store.blobPath(resolved.blobRef))); } catch { /* stale blob */ }
    }
    return { ...resolved, ...(uri ? { uri } : {}) };
  }
  let previewUri: string | undefined;
  let sceneJson: string | undefined;
  if (resolved.previewAvailable) {
    try { previewUri = dataUri("image/png", fs.readFileSync(store.blobPath(resolved.previewBlobRef))); } catch { /* stale blob */ }
  }
  if (resolved.sceneAvailable) {
    try { sceneJson = store.readExcalidrawScene(resolved); } catch { /* stale or corrupt scene */ }
  }
  return { ...resolved, ...(previewUri ? { previewUri } : {}), ...(sceneJson ? { sceneJson } : {}) };
}

function imagePayload(input: TaskStudioImageInput): TaskStudioImagePayloadV1 {
  const value = validatePayload("put-image", {
    schemaVersion: 1,
    mediaType: input.mediaType,
    ...(input.name !== undefined ? { name: input.name } : {}),
    source: input.source,
    dataBase64: input.data.toString("base64"),
  });
  if (!("dataBase64" in value) || !("mediaType" in value)) throw new Error("Task Studio image payload has the wrong shape");
  return value;
}

function sketchPayload(input: TaskStudioSketchInput): TaskStudioSketchPayloadV1 {
  const value = validatePayload("put-sketch", {
    schemaVersion: 1,
    ...(input.attachmentId !== undefined ? { attachmentId: input.attachmentId } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    source: input.source,
    ...(input.baseImageAttachmentId !== undefined ? { baseImageAttachmentId: input.baseImageAttachmentId } : {}),
    sceneJson: input.sceneJson,
    previewBase64: input.previewData.toString("base64"),
  });
  if (!("sceneJson" in value)) throw new Error("Task Studio sketch payload has the wrong shape");
  return value;
}

function prototypePayload(input: { html: string; title: string }): TaskStudioPrototypePayloadV1 {
  const value = validatePayload("import-prototype", { schemaVersion: 1, html: input.html, title: input.title });
  if (!("html" in value)) throw new Error("Task Studio prototype payload has the wrong shape");
  return value;
}

function validatePayload(action: TaskStudioApplyActionV1, value: unknown): TaskStudioStagedPayloadV1 {
  return parseTaskStudioStagedPayloadV1(action, Buffer.from(JSON.stringify(value), "utf8"));
}

function serviceSaveResult(result: Awaited<ReturnType<typeof saveTaskStudio>>): StudioSaveResult {
  if (result.status === "ok") return result;
  if (result.status === "conflict") return { status: "conflict", error: { code: "task/precondition-failed", message: result.message } };
  return { status: "error", error: { code: `persistence/${result.code.toLowerCase().replaceAll("_", "-")}`, message: result.message, source: "persistence" } };
}

function emptyEntity(identity: WorkspacePresentationTarget, knownAgents: string[]): TaskDetailEntity {
  return {
    taskId: "new",
    workspaceHash: identity.wsHash,
    folder: identity.folderName,
    title: "",
    deps: [],
    artifact_refs: [],
    doc: { type: "doc", content: [{ type: "paragraph" }] },
    attachments: [],
    anchor: "load",
    knownAgents: [...knownAgents].sort(),
    prototypes: { readOnly: false, prototypes: [] },
  };
}

function dataUri(mediaType: string, data: Buffer): string {
  return `data:${mediaType};base64,${data.toString("base64")}`;
}
