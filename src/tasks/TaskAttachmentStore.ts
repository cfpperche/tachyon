import path from "node:path";
import { isBlobRef, RichDocAttachmentStore, safeDisplayComponent } from "../richDoc/AttachmentStore.js";
import { TASK_ID_RE } from "./types.js";

export {
  ALLOWED_IMAGE_TYPES as TASK_ALLOWED_IMAGE_TYPES,
  IMAGE_MAX_BYTES as TASK_IMAGE_MAX_BYTES,
  BLOB_SOFT_LIMIT_BYTES as TASK_BLOB_SOFT_LIMIT_BYTES,
  EXCALIDRAW_SCENE_MEDIA_TYPE as TASK_EXCALIDRAW_SCENE_MEDIA_TYPE,
} from "../richDoc/AttachmentStore.js";
export type { PutExcalidrawInput as PutTaskExcalidrawInput, PutImageInput as PutTaskImageInput } from "../richDoc/AttachmentStore.js";
export type { RichDocAttachment as TaskAttachment, ResolvedRichDocAttachment as ResolvedTaskAttachment } from "../richDoc/types.js";

/**
 * spec 339 (T2) — the task-entity namespace over the shared rich-doc blob/scene mechanics. Every instance
 * is bound to exactly one task id; blobs live under `.tachyon/tasks/attachments/<task-id>/blobs/…` so one
 * task can never read or overwrite another task's blobs (namespace isolation), and `blobPath` (inherited
 * from `RichDocAttachmentStore`) rejects any blob ref that isn't a bare 64-hex sha256 — no traversal.
 */
export class TaskAttachmentStore extends RichDocAttachmentStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly taskId: string,
  ) {
    super();
    if (!TASK_ID_RE.test(taskId)) throw new Error(`invalid task id '${taskId}'`);
  }

  get taskAttachmentsDir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "tasks", "attachments", this.taskId);
  }

  get blobDir(): string {
    return path.join(this.taskAttachmentsDir, "blobs");
  }

  relativeBlobPath(blobRef: string): string {
    if (!isBlobRef(blobRef)) throw new Error(`invalid task attachment blob ref '${blobRef}'`);
    return `.tachyon/tasks/attachments/${this.taskId}/blobs/${blobRef}`;
  }

  protected fallbackRelativePath(blobRef: string): string {
    return `.tachyon/tasks/attachments/${this.taskId}/blobs/${safeDisplayComponent(blobRef)}`;
  }

  protected blobRefLabel(): string {
    return "task attachment blob ref";
  }
}
