import { z } from "zod";
import type { RichDocAttachment, TiptapJSON } from "../richDoc/types.js";
import { TaskDetailStore } from "../tasks/TaskDetailStore.js";
import { markdownToDoc } from "../tasks/markdownDoc.js";
import { decideAnchor } from "../tasks/studioModel.js";
import type { TaskStore } from "../tasks/TaskStore.js";
import { TASK_PRIORITIES } from "../tasks/types.js";
import {
  projectTaskPrototypeList,
  taskPrototypeListProjectionV1Schema,
} from "./taskDetailProjection.js";

const TASK_ID_RE = /^t-[0-9a-f]{6}$/;
const ATTACHMENT_ID_RE = /^att-[0-9a-f]{6}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_DOC_NODES = 100_000;
const MAX_DOC_DEPTH = 64;

const taskId = z.string().regex(TASK_ID_RE);
const timestamp = z.string().max(64).refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");
const priority = z.union(TASK_PRIORITIES.map((value) => z.literal(value)) as [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]);
const artifactRef = z.object({
  type: nonEmptyText(64),
  ref: nonEmptyText(500),
  role: z.enum(["deliverable", "relation"]).optional(),
}).strict();
const dependency = z.object({
  id: taskId,
  title: nonEmptyText(300).optional(),
  missing: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.missing && value.title !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "missing dependency carries a title" });
  if (!value.missing && value.title === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "live dependency is missing its title" });
});

const imageAttachment = z.object({
  id: z.string().regex(ATTACHMENT_ID_RE),
  kind: z.literal("image"),
  blobRef: z.string().regex(SHA256_RE),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  name: nonEmptyText(500),
  size: z.number().int().nonnegative().max(10 * 1024 * 1024),
  width: z.number().int().positive().max(1_000_000).optional(),
  height: z.number().int().positive().max(1_000_000).optional(),
  createdAt: timestamp,
  source: z.enum(["paste", "drop", "import"]),
  visibility: z.literal("local"),
}).strict();

const sketchAttachment = z.object({
  id: z.string().regex(ATTACHMENT_ID_RE),
  kind: z.literal("excalidraw"),
  name: nonEmptyText(500),
  sceneBlobRef: z.string().regex(SHA256_RE),
  previewBlobRef: z.string().regex(SHA256_RE),
  sceneMediaType: z.literal("application/vnd.tachyon.excalidraw+json"),
  previewMediaType: z.literal("image/png"),
  sceneSize: z.number().int().positive().max(64 * 1024 * 1024),
  previewSize: z.number().int().nonnegative().max(10 * 1024 * 1024),
  elementCount: z.number().int().nonnegative().max(1_000_000),
  createdAt: timestamp,
  updatedAt: timestamp,
  source: z.enum(["blank", "annotate-image"]),
  baseImageAttachmentId: z.string().regex(ATTACHMENT_ID_RE).optional(),
  visibility: z.literal("local"),
}).strict();

export const taskStudioAttachmentV1Schema = z.discriminatedUnion("kind", [imageAttachment, sketchAttachment]);

const projection = z.object({
  schemaVersion: z.literal(1),
  taskId,
  title: z.string().max(300),
  kind: nonEmptyText(64).optional(),
  priority: priority.optional(),
  assignee: nonEmptyText(64).optional(),
  deps: z.array(dependency).max(500),
  artifact_refs: z.array(artifactRef).max(10),
  doc: z.custom<TiptapJSON>(isTiptapDoc, "invalid bounded Tiptap document"),
  attachments: z.array(taskStudioAttachmentV1Schema).max(500),
  bodyBaseline: z.string().max(4_000).optional(),
  anchor: z.enum(["load", "reimport", "read-only"]),
  anchorError: nonEmptyText(2_000).optional(),
  expectUpdatedAt: timestamp.optional(),
  prototypes: taskPrototypeListProjectionV1Schema,
}).strict().superRefine((value, context) => {
  if (new Set(value.deps.map((row) => row.id)).size !== value.deps.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate Task Studio dependency ids" });
  }
  if (new Set(value.attachments.map((row) => row.id)).size !== value.attachments.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate Task Studio attachment ids" });
  }
  if ((value.anchor === "read-only") !== (value.anchorError !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Task Studio read-only anchor and error disagree" });
  }
});

export type TaskStudioProjectionV1 = z.infer<typeof projection>;

export interface TaskStudioViewV1 {
  schemaVersion: 1;
  studio: TaskStudioProjectionV1;
}

export function parseTaskStudioProjectionV1(value: unknown): TaskStudioProjectionV1 {
  return projection.parse(value);
}

export function parseTaskStudioViewV1(value: unknown): TaskStudioViewV1 {
  return z.object({ schemaVersion: z.literal(1), studio: projection }).strict().parse(value);
}

export function isTaskStudioViewV1(value: unknown): value is TaskStudioViewV1 {
  return z.object({ schemaVersion: z.literal(1), studio: projection }).strict().safeParse(value).success;
}

export function projectTaskStudio(
  store: TaskStore,
  workspaceRoot: string,
  id: string,
): TaskStudioProjectionV1 {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid task id '${id}'`);
  let task: ReturnType<TaskStore["get"]> | undefined;
  try { task = store.get(id); } catch { /* pre-minted new-task id */ }
  if (!task) {
    return parseTaskStudioProjectionV1({
      schemaVersion: 1,
      taskId: id,
      title: "",
      deps: [],
      artifact_refs: [],
      doc: emptyDoc(),
      attachments: [],
      anchor: "load",
      prototypes: projectTaskPrototypeList(workspaceRoot, id),
    });
  }

  const detailRead = new TaskDetailStore(workspaceRoot).read(id);
  const anchor = decideAnchor(task, detailRead);
  const doc = anchor.action === "load" && detailRead.status === "ok"
    ? detailRead.detail.doc
    : anchor.action === "reimport"
      ? markdownToDoc(task.body ?? "")
      : emptyDoc();
  const attachments: RichDocAttachment[] = anchor.action === "load" && detailRead.status === "ok"
    ? detailRead.detail.attachments
    : [];
  return parseTaskStudioProjectionV1({
    schemaVersion: 1,
    taskId: id,
    title: task.title,
    ...(task.kind !== undefined ? { kind: task.kind } : {}),
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
    ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
    deps: (task.deps ?? []).map((depId) => {
      try { return { id: depId, title: store.get(depId).title, missing: false }; }
      catch { return { id: depId, missing: true }; }
    }),
    artifact_refs: task.artifact_refs ?? [],
    doc,
    attachments,
    bodyBaseline: task.body ?? "",
    anchor: anchor.action,
    ...(anchor.action === "read-only" ? { anchorError: anchor.reason } : {}),
    expectUpdatedAt: task.updatedAt,
    prototypes: projectTaskPrototypeList(workspaceRoot, id),
  });
}

export function isTiptapDoc(value: unknown): value is TiptapJSON {
  if (!isFiniteJsonTree(value, MAX_DOC_DEPTH, MAX_DOC_NODES) || !isRecord(value)) return false;
  const stack: Array<{ node: Record<string, unknown>; depth: number }> = [{ node: value, depth: 0 }];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    count += 1;
    if (count > MAX_DOC_NODES || current.depth > MAX_DOC_DEPTH) return false;
    if (!Object.keys(current.node).every((key) => key === "type" || key === "attrs" || key === "content" || key === "text" || key === "marks")) return false;
    if (typeof current.node.type !== "string" || current.node.type.length === 0 || current.node.type.length > 64) return false;
    if (current.node.attrs !== undefined && !isRecord(current.node.attrs)) return false;
    if (current.node.text !== undefined && (typeof current.node.text !== "string" || current.node.text.length > 16 * 1024 * 1024)) return false;
    if (current.node.marks !== undefined) {
      if (!Array.isArray(current.node.marks) || current.node.marks.length > 128) return false;
      for (const mark of current.node.marks) {
        if (!isRecord(mark)
          || !Object.keys(mark).every((key) => key === "type" || key === "attrs")
          || typeof mark.type !== "string" || mark.type.length === 0 || mark.type.length > 64
          || (mark.attrs !== undefined && !isRecord(mark.attrs))) return false;
      }
    }
    if (current.node.content !== undefined) {
      if (!Array.isArray(current.node.content) || current.node.content.length > MAX_DOC_NODES) return false;
      for (const child of current.node.content) {
        if (!isRecord(child)) return false;
        stack.push({ node: child, depth: current.depth + 1 });
      }
    }
  }
  return value.type === "doc";
}

function isFiniteJsonTree(value: unknown, maxDepth: number, maxNodes: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    count += 1;
    if (count > maxNodes || current.depth > maxDepth) return false;
    const nested = current.value;
    if (nested === null || typeof nested === "string" || typeof nested === "boolean") continue;
    if (typeof nested === "number") { if (!Number.isFinite(nested)) return false; continue; }
    if (Array.isArray(nested)) {
      for (const item of nested) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(nested)) return false;
    for (const [key, item] of Object.entries(nested)) {
      if (key.length > 256) return false;
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyText(max: number): z.ZodType<string> {
  return z.string().min(1).max(max);
}

function emptyDoc(): TiptapJSON {
  return { type: "doc", content: [{ type: "paragraph" }] };
}
