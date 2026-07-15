import { z } from "zod";
import type { RichDocAttachment } from "../richDoc/types.js";
import type { ArtifactRef, TaskPriority } from "../tasks/types.js";
import {
  decodeRichDocBase64,
  isTiptapDoc,
  RICH_DOC_IMAGE_MAX_BYTES,
  richDocAttachmentV1Schema,
  richDocImagePayloadV1Schema,
  richDocSketchPayloadV1Schema,
  type RichDocImagePayloadV1,
  type RichDocSketchPayloadV1,
} from "./richDocWire.js";
import { isStagedPayloadRefV1, type StagedPayloadRefV1 } from "./stagedPayload.js";

export const TASK_STUDIO_STAGED_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const TASK_STUDIO_IMAGE_MAX_BYTES = RICH_DOC_IMAGE_MAX_BYTES;
export const TASK_STUDIO_PROTOTYPE_MAX_BYTES = 512 * 1024;
const taskId = z.string().regex(/^t-[0-9a-f]{6}$/);
const boundedBytes = (max: number, label: string) => z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= max,
  `${label} exceeds ${max} bytes`,
);

export type TaskStudioApplyActionV1 = "save" | "put-image" | "put-sketch" | "import-prototype";

export interface TaskStudioApplyInputV1 {
  taskId: string;
  action: TaskStudioApplyActionV1;
  payload: StagedPayloadRefV1;
}

export interface TaskStudioCancelInputV1 {
  taskId: string;
}

export interface TaskStudioPatchV1 {
  title: string;
  kind?: string;
  priority?: TaskPriority;
  assignee?: string;
  deps: string[];
  artifact_refs: ArtifactRef[];
  doc: import("../richDoc/types.js").TiptapJSON;
  attachments: RichDocAttachment[];
  bodyBaseline?: string;
  dirty: {
    title?: boolean;
    kind?: boolean;
    priority?: boolean;
    assignee?: boolean;
    deps?: boolean;
    artifact_refs?: boolean;
  };
  docDirty: boolean;
  expectUpdatedAt?: string;
}

export type TaskStudioImagePayloadV1 = RichDocImagePayloadV1;
export type TaskStudioSketchPayloadV1 = RichDocSketchPayloadV1;

export interface TaskStudioPrototypePayloadV1 {
  schemaVersion: 1;
  title: string;
  html: string;
}

export type TaskStudioStagedPayloadV1 =
  | { schemaVersion: 1; patch: TaskStudioPatchV1 }
  | TaskStudioImagePayloadV1
  | TaskStudioSketchPayloadV1
  | TaskStudioPrototypePayloadV1;

const artifactRef = z.object({
  type: z.string().min(1).max(64),
  ref: z.string().min(1).max(500),
  role: z.enum(["deliverable", "relation"]).optional(),
}).strict();
const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const dirty = z.object({
  title: z.boolean().optional(),
  kind: z.boolean().optional(),
  priority: z.boolean().optional(),
  assignee: z.boolean().optional(),
  deps: z.boolean().optional(),
  artifact_refs: z.boolean().optional(),
}).strict();
const patch = z.object({
  title: z.string().max(300),
  kind: z.string().min(1).max(64).optional(),
  priority: priority.optional(),
  assignee: z.string().min(1).max(64).optional(),
  deps: z.array(taskId).max(500),
  artifact_refs: z.array(artifactRef).max(10),
  doc: z.custom<TaskStudioPatchV1["doc"]>(isTiptapDoc, "invalid bounded Tiptap document"),
  attachments: z.array(richDocAttachmentV1Schema).max(500),
  bodyBaseline: z.string().max(4_000).optional(),
  dirty,
  docDirty: z.boolean(),
  expectUpdatedAt: z.string().min(1).max(64)
    .refine((value) => Number.isFinite(Date.parse(value)), "invalid expected task timestamp")
    .optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.deps).size !== value.deps.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate task dependencies" });
  if (new Set(value.attachments.map((row) => row.id)).size !== value.attachments.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate task attachments" });
  }
});
const savePayload = z.object({ schemaVersion: z.literal(1), patch }).strict();
const prototypePayload = z.object({
  schemaVersion: z.literal(1),
  title: boundedBytes(200, "prototype title").refine((value) => value.trim().length > 0, "prototype title is empty"),
  html: boundedBytes(TASK_STUDIO_PROTOTYPE_MAX_BYTES, "prototype HTML").refine((value) => value.length > 0, "prototype HTML is empty"),
}).strict();

export function isTaskStudioApplyInputV1(value: unknown): value is TaskStudioApplyInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<TaskStudioApplyInputV1>;
  return Object.keys(value).length === 3
    && Object.keys(value).every((key) => key === "taskId" || key === "action" || key === "payload")
    && typeof input.taskId === "string" && /^t-[0-9a-f]{6}$/.test(input.taskId)
    && (input.action === "save" || input.action === "put-image" || input.action === "put-sketch" || input.action === "import-prototype")
    && isStagedPayloadRefV1(input.payload);
}

export function isTaskStudioCancelInputV1(value: unknown): value is TaskStudioCancelInputV1 {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as { taskId?: unknown }).taskId === "string"
    && /^t-[0-9a-f]{6}$/.test((value as { taskId: string }).taskId);
}

export function parseTaskStudioStagedPayloadV1(
  action: TaskStudioApplyActionV1,
  bytes: Buffer,
): TaskStudioStagedPayloadV1 {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength <= 0 || bytes.byteLength > TASK_STUDIO_STAGED_PAYLOAD_MAX_BYTES) {
    throw new Error("Task Studio staged payload violates its byte limit");
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Task Studio staged payload is not valid JSON"); }
  if (action === "save") return savePayload.parse(value) as { schemaVersion: 1; patch: TaskStudioPatchV1 };
  if (action === "put-image") return richDocImagePayloadV1Schema.parse(value) as TaskStudioImagePayloadV1;
  if (action === "put-sketch") return richDocSketchPayloadV1Schema.parse(value) as TaskStudioSketchPayloadV1;
  return prototypePayload.parse(value) as TaskStudioPrototypePayloadV1;
}

export function encodeTaskStudioStagedPayloadV1(value: TaskStudioStagedPayloadV1): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function decodeTaskStudioBase64(value: string, label: string): Buffer {
  return decodeRichDocBase64(value, label);
}
