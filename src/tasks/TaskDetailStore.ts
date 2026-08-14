import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TaskAttachmentStore } from "./TaskAttachmentStore.js";
import { TASK_ID_RE, type ArtifactRef, type Task, type TaskPriority } from "@tachyon/shared/tasks/types.js";
import type { TaskStore } from "./TaskStore.js";
import type { ResolvedRichDocAttachment, RichDocAttachment, TiptapJSON } from "@tachyon/shared/richDoc/types.js";

/**
 * spec 339 (T3) — the Task Studio sidecar: `.tachyon/tasks/details/<id>.json`, the rich-doc companion to
 * `task.body`. The queue's per-task JSON file (`TaskStore`) stays the canonical record; this sidecar is a
 * DERIVED companion anchored to it by `bodyHash` (the hash of the `task.body` it was last derived from) —
 * anchoring DECISIONS (load-as-is vs reimport-from-body) are pure logic in `studioModel.ts` (T4), not here.
 * This module is the I/O layer: schema validation, atomic writes, and the lifecycle rules from the spec.
 */

export const TASK_DETAIL_SCHEMA_VERSION = 1 as const;

export interface TaskDetail {
  schemaVersion: 1;
  taskId: string;
  doc: TiptapJSON;
  attachments: RichDocAttachment[];
  bodyHash: string;
  taskUpdatedAt: string;
}

export type TaskDetailReadResult =
  | { status: "missing" }
  | { status: "malformed"; error: string }
  | { status: "ok"; detail: TaskDetail };

export interface CreateStagedInput {
  title: string;
  kind?: string;
  priority?: TaskPriority;
  artifact_refs?: ArtifactRef[];
  deps?: string[];
  doc: TiptapJSON;
  attachments: RichDocAttachment[];
  /** the markdown already derived from `doc` (via `docMarkdown.ts`, T4) — stored verbatim as `task.body`. */
  body: string;
  now?: string;
}

export function hashBody(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

export class TaskDetailStore {
  constructor(private readonly workspaceRoot: string) {}

  get detailsDir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "tasks", "details");
  }

  detailPath(taskId: string): string {
    if (!TASK_ID_RE.test(taskId)) throw new Error(`invalid task id '${taskId}'`);
    return path.join(this.detailsDir, `${taskId}.json`);
  }

  /** Missing sidecar = valid (F6): the caller reimports from `task.body`. Malformed or an unknown/newer
   * `schemaVersion` = fail-closed read-only — never overwritten by `write()` without explicit recovery
   * (callers must not pass a malformed read's content back into `write()`; scalar task edits are unaffected
   * since they go through `TaskStore`, not this store). */
  read(taskId: string): TaskDetailReadResult {
    let raw: string;
    try {
      raw = fs.readFileSync(this.detailPath(taskId), "utf8");
    } catch {
      return { status: "missing" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "malformed", error: `.tachyon/tasks/details/${taskId}.json is not valid JSON` };
    }
    const detail = parsed as Partial<TaskDetail>;
    if (detail.schemaVersion !== 1) {
      return { status: "malformed", error: `.tachyon/tasks/details/${taskId}.json has an unsupported schemaVersion (expected 1)` };
    }
    if (detail.taskId !== taskId || !detail.doc || !Array.isArray(detail.attachments) || typeof detail.bodyHash !== "string" || typeof detail.taskUpdatedAt !== "string") {
      return { status: "malformed", error: `.tachyon/tasks/details/${taskId}.json is not a well-formed task detail sidecar` };
    }
    for (const attachment of detail.attachments) assertTaskAttachment(attachment);
    return { status: "ok", detail: detail as TaskDetail };
  }

  /** Resolve a sidecar's attachments into webview-displayable form (paths + availability), scoped to `taskId`'s own namespace. */
  resolveAttachments(taskId: string, attachments: RichDocAttachment[]): ResolvedRichDocAttachment[] {
    const store = new TaskAttachmentStore(this.workspaceRoot, taskId);
    return attachments.map((att) => store.resolveAttachment(att));
  }

  write(detail: TaskDetail): void {
    if (detail.schemaVersion !== 1) throw new Error("task detail sidecar must be schemaVersion 1");
    if (!TASK_ID_RE.test(detail.taskId)) throw new Error(`invalid task id '${detail.taskId}'`);
    fs.mkdirSync(this.detailsDir, { recursive: true });
    const target = this.detailPath(detail.taskId);
    const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, `${JSON.stringify(detail, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
  }

  /**
   * The staged create transaction (F7/F11 dueto fold): `taskStore.create({ id, ... })` uses the id Task
   * Studio already reserved for its attachment namespace (via `mintTaskId()`), THEN the sidecar is written
   * keyed to the (now-real) task id. If `taskStore.create` throws, nothing was created and nothing here was
   * written — the caller cleans up its provisional attachment directory (T7 integration test). If the
   * sidecar write throws AFTER the task was created, the task simply has no sidecar yet — an explicitly
   * valid lifecycle state (F6), not an orphan; the caller surfaces the sidecar error to the user.
   */
  async createStaged(taskStore: TaskStore, id: string, input: CreateStagedInput): Promise<Task> {
    const now = input.now ?? new Date().toISOString();
    const task = await taskStore.create({
      id,
      title: input.title,
      author: "human",
      ...(input.body.trim() ? { body: input.body } : {}),
      now,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.artifact_refs !== undefined ? { artifact_refs: input.artifact_refs } : {}),
      ...(input.deps !== undefined ? { deps: input.deps } : {}),
    });
    this.write({
      schemaVersion: 1,
      taskId: task.id,
      doc: input.doc,
      attachments: input.attachments,
      bodyHash: hashBody(input.body),
      taskUpdatedAt: task.updatedAt,
    });
    return task;
  }

  /** Best-effort delete of the sidecar + its whole attachment namespace (DROPPED tasks keep both — this is
   * for hard deletion only). Failures are collected, never thrown (F6/F13: best-effort, logged). */
  delete(taskId: string): { errors: string[] } {
    const errors: string[] = [];
    try {
      fs.rmSync(this.detailPath(taskId), { force: true });
    } catch (err) {
      errors.push(`sidecar: ${errorMessage(err)}`);
    }
    try {
      fs.rmSync(new TaskAttachmentStore(this.workspaceRoot, taskId).taskAttachmentsDir, { recursive: true, force: true });
    } catch (err) {
      errors.push(`attachments: ${errorMessage(err)}`);
    }
    return { errors };
  }

  /** Garbage-collects blobs that `next` no longer references but `previous` did (F13: best-effort, never
   * throws). Content-addressed dedup means a blob still referenced by ANY kept attachment is never removed. */
  gcRemovedAttachments(taskId: string, previous: RichDocAttachment[], next: RichDocAttachment[]): { removed: string[]; errors: string[] } {
    const store = new TaskAttachmentStore(this.workspaceRoot, taskId);
    const keep = new Set<string>();
    for (const att of next) blobRefsOf(att).forEach((ref) => keep.add(ref));
    const stale = new Set<string>();
    for (const att of previous) {
      for (const ref of blobRefsOf(att)) {
        if (!keep.has(ref)) stale.add(ref);
      }
    }
    const removed: string[] = [];
    const errors: string[] = [];
    for (const blobRef of stale) {
      try {
        fs.rmSync(store.blobPath(blobRef), { force: true });
        removed.push(blobRef);
      } catch (err) {
        errors.push(`${blobRef}: ${errorMessage(err)}`);
      }
    }
    return { removed, errors };
  }
}

function blobRefsOf(att: RichDocAttachment): string[] {
  return att.kind === "image" ? [att.blobRef] : [att.sceneBlobRef, att.previewBlobRef];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertTaskAttachment(value: RichDocAttachment): void {
  if (value.kind === "image") {
    if (!value.id || !value.blobRef || !value.mediaType || !value.name || typeof value.size !== "number") {
      throw new Error(`task attachment is missing required image fields`);
    }
    return;
  }
  if (value.kind === "excalidraw") {
    if (!value.id || !value.sceneBlobRef || !value.previewBlobRef || !value.name || typeof value.sceneSize !== "number" || typeof value.previewSize !== "number") {
      throw new Error(`task attachment is missing required sketch fields`);
    }
    return;
  }
  throw new Error(`task attachment kind is not supported`);
}
