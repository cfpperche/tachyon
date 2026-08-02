import path from "node:path";
import { z } from "zod";
import { TaskAttachmentStore } from "../tasks/TaskAttachmentStore.js";
import { TaskDetailStore } from "../tasks/TaskDetailStore.js";
import { TaskPrototypeStore } from "../tasks/TaskPrototypeStore.js";
import type { TaskStore } from "../tasks/TaskStore.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../tasks/types.js";

const taskId = z.string().regex(/^t-[0-9a-f]{6}$/);
const prototypeId = z.string().regex(/^p-[0-9a-f]{12}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = boundedText(64).refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");
const taskStatus = z.enum(TASK_STATUSES);
const taskPriority = z.union(TASK_PRIORITIES.map((priority) => z.literal(priority)) as [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]);

const artifactRef = z.object({
  type: persistedText(),
  ref: persistedText(),
  role: z.enum(["deliverable", "relation"]).optional(),
}).strict();

const task = z.object({
  id: taskId,
  title: persistedText(),
  body: persistedText().optional(),
  status: taskStatus,
  priority: taskPriority.optional(),
  kind: persistedText().optional(),
  author: persistedText(),
  assignee: persistedText().optional(),
  artifact_refs: z.array(artifactRef).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

const journalEntry = z.object({
  id: z.string().regex(/^j-[0-9a-f]{12}$/),
  ts: timestamp,
  author: persistedText(),
  text: persistedText(),
}).strict();

const derived = z.object({
  sdd: z.object({
    type: z.literal("sdd"),
    ref: persistedText(),
    status: z.enum(["draft", "in-progress", "shipped", "shipped-partial", "superseded", "abandoned", "deferred"]).optional(),
    missing: z.boolean().optional(),
  }).strict().optional(),
}).strict();

const attention = z.object({
  code: z.enum(["dangling_dep", "missing_sdd_spec", "ready_to_close", "sdd_needs_retriage", "corrupt_task", "awaiting_human"]),
  // `awaiting_human` carries a persisted `reason`, and the rest interpolate persisted refs.
  message: persistedText(),
  ref: persistedText().optional(),
}).strict();

const dependency = z.object({
  id: taskId,
  title: persistedText().optional(),
  status: taskStatus.optional(),
  missing: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.missing && (value.title !== undefined || value.status !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "missing dependency carries live fields" });
  }
  if (!value.missing && (value.title === undefined || value.status === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "live dependency is incomplete" });
  }
});

const imageAttachment = z.object({
  id: z.string().regex(/^att-[0-9a-f]{6}$/),
  blobRef: sha256,
  available: z.boolean(),
}).strict();

const prototype = z.object({
  id: prototypeId,
  sha256,
  state: z.enum(["draft", "approved", "superseded", "rejected"]),
  title: boundedText(200),
  author: boundedText(64),
  createdAt: timestamp,
  available: z.boolean(),
  integrity: z.enum(["verified", "missing", "mismatch", "policy-unknown"]),
  needsTaskReconciliation: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.available !== (value.integrity === "verified")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "prototype availability contradicts integrity" });
  }
});

export const taskPrototypeListProjectionV1Schema = z.object({
  updatedAt: timestamp.optional(),
  readOnly: z.boolean(),
  error: boundedText(2_000).optional(),
  prototypes: z.array(prototype).max(500),
}).strict().superRefine((value, context) => {
  if (new Set(value.prototypes.map((row) => row.id)).size !== value.prototypes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate prototype ids" });
  }
});

const projection = z.object({
  schemaVersion: z.literal(1),
  task,
  journal: z.array(journalEntry).max(4_096),
  derived: derived.optional(),
  attention: z.array(attention).max(16).optional(),
  deps: z.array(dependency).max(500),
  imageAttachments: z.array(imageAttachment).max(500),
  prototypes: taskPrototypeListProjectionV1Schema,
}).strict().superRefine((value, context) => {
  if (new Set(value.deps.map((row) => row.id)).size !== value.deps.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate dependency ids" });
  }
  if (new Set(value.imageAttachments.map((row) => row.id)).size !== value.imageAttachments.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate attachment ids" });
  }
});

export type TaskDetailProjectionV1 = z.infer<typeof projection>;
export type TaskPrototypeListProjectionV1 = z.infer<typeof taskPrototypeListProjectionV1Schema>;

export interface TaskDetailViewV1 {
  schemaVersion: 1;
  detail: TaskDetailProjectionV1;
}

export function parseTaskDetailProjectionV1(value: unknown): TaskDetailProjectionV1 {
  return projection.parse(value);
}

export function isTaskDetailProjectionV1(value: unknown): value is TaskDetailProjectionV1 {
  return projection.safeParse(value).success;
}

export function parseTaskDetailViewV1(value: unknown): TaskDetailViewV1 {
  const parsed = z.object({ schemaVersion: z.literal(1), detail: projection }).strict().parse(value);
  return parsed;
}

export function isTaskDetailViewV1(value: unknown): value is TaskDetailViewV1 {
  try { parseTaskDetailViewV1(value); return true; } catch { return false; }
}

export function parseTaskPrototypeListProjectionV1(value: unknown): TaskPrototypeListProjectionV1 {
  return taskPrototypeListProjectionV1Schema.parse(value);
}

export function projectTaskDetail(store: TaskStore, workspaceRoot: string, id: string): TaskDetailProjectionV1 {
  const view = store.getView(id, { includeJournal: true });
  const detailStore = new TaskDetailStore(workspaceRoot);
  const detailRead = detailStore.read(id);
  const imageAttachments = detailRead.status === "ok"
    ? detailStore.resolveAttachments(id, detailRead.detail.attachments)
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({ id: attachment.id, blobRef: attachment.blobRef, available: attachment.available }))
    : [];
  const prototypeProjection = projectTaskPrototypeList(workspaceRoot, id);
  return parseTaskDetailProjectionV1({
    schemaVersion: 1,
    task: {
      id: view.task.id,
      title: view.task.title,
      ...(view.task.body !== undefined ? { body: view.task.body } : {}),
      status: view.task.status,
      ...(view.task.priority !== undefined ? { priority: view.task.priority } : {}),
      ...(view.task.kind !== undefined ? { kind: view.task.kind } : {}),
      author: view.task.author,
      ...(view.task.assignee !== undefined ? { assignee: view.task.assignee } : {}),
      ...(view.task.artifact_refs !== undefined ? { artifact_refs: view.task.artifact_refs } : {}),
      createdAt: view.task.createdAt,
      updatedAt: view.task.updatedAt,
    },
    journal: view.journal ?? [],
    ...(view.derived ? { derived: view.derived } : {}),
    ...(view.attention?.length ? { attention: view.attention.slice(0, 16) } : {}),
    deps: (view.task.deps ?? []).map((depId) => {
      try {
        const dep = store.get(depId);
        return { id: depId, title: dep.title, status: dep.status, missing: false };
      } catch {
        return { id: depId, missing: true };
      }
    }),
    imageAttachments,
    prototypes: prototypeProjection,
  });
}

export function projectTaskPrototypeList(workspaceRoot: string, id: string): TaskPrototypeListProjectionV1 {
  const snapshot = new TaskPrototypeStore(workspaceRoot, id).read();
  return parseTaskPrototypeListProjectionV1({
    ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
    readOnly: snapshot.readOnly,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    prototypes: snapshot.prototypes.map((row) => ({
      id: row.id,
      sha256: row.sha256,
      state: row.state,
      title: row.title,
      author: row.author,
      createdAt: row.createdAt,
      available: row.available,
      integrity: row.integrity,
      ...(row.needsTaskReconciliation ? { needsTaskReconciliation: true } : {}),
    })),
  });
}

/** The Task Detail shell may map a verified blob to a webview URI but never writes it. */
export function taskDetailAttachmentBlobRoot(workspaceRoot: string, taskIdValue: string): string {
  return new TaskAttachmentStore(workspaceRoot, taskIdValue).blobDir;
}

/**
 * t-4d59d3 — the stable per-workspace PARENT of every task's blob dir
 * (`.tachyon/tasks/attachments`). Control grants this once at panel CREATION instead of
 * re-granting one task's own blob dir per navigation: reassigning `webview.options` on a live
 * panel makes VS Code recreate the webview's inner iframe, and that reload can wedge at the
 * fake.html placeholder — the whole Control surface goes permanently blank (the "click a Board
 * card → blank screen" bug). Must stay in sync with TaskAttachmentStore.taskAttachmentsDir's
 * parent.
 */
export function taskDetailAttachmentsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "tasks", "attachments");
}

export function taskDetailAttachmentBlobPath(workspaceRoot: string, taskIdValue: string, blobRef: string): string {
  return new TaskAttachmentStore(workspaceRoot, taskIdValue).blobPath(blobRef);
}

export function readTaskDetailPrototypeHtml(workspaceRoot: string, taskIdValue: string, prototypeIdValue: string): string {
  return new TaskPrototypeStore(workspaceRoot, taskIdValue).readHtml(prototypeIdValue);
}

function boundedText(maxCodePoints: number): z.ZodType<string> {
  return z.string().refine((value) => {
    const length = [...value].length;
    return length > 0 && length <= maxCodePoints;
  }, `expected 1-${maxCodePoints} code points`);
}

/**
 * t-c2882f — a field carrying PERSISTED content, bounded only by being non-empty.
 *
 * These used to be `boundedText` at the authoring numbers (title 300, body 4000, kind 64, refs 10),
 * which made this wire contract a SECOND door onto the same defect `TaskStore` had. Measured, not
 * assumed: with the store already fixed, all three tasks this was filed on still threw
 * `expected 1-4000 code points` here, so they stayed invisible to the human while being served to
 * agents. The repo's actor-times-trigger rule is exactly this — the Interface reaches the same
 * records through a door the store fix never touched.
 *
 * The store is the authority on what is persisted, and a projection that cannot carry what the store
 * serves is a projection that hides records. Structure stays exact: ids, timestamps, enums, and the
 * counts of collections this projection builds itself. Only persisted values are unbounded, because
 * the authoring door is where a size is refused — before the value ever reaches disk.
 */
function persistedText(): z.ZodType<string> {
  return z.string().refine((value) => value.length > 0, "expected a non-empty persisted value");
}
