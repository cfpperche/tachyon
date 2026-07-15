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
import {
  isTiptapDoc,
  richDocAttachmentV1Schema,
} from "./richDocWire.js";

const TASK_ID_RE = /^t-[0-9a-f]{6}$/;

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

export const taskStudioAttachmentV1Schema = richDocAttachmentV1Schema;
export { isTiptapDoc } from "./richDocWire.js";

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

function nonEmptyText(max: number): z.ZodType<string> {
  return z.string().min(1).max(max);
}

function emptyDoc(): TiptapJSON {
  return { type: "doc", content: [{ type: "paragraph" }] };
}
