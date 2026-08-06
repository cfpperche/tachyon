import { mintTaskId } from "../tasks/TaskStore.js";
import type { WorkspaceTaskStudioTarget } from "../shell/TaskStudioTarget.js";
import type {
  StudioHostAdapter,
  StudioLoadResult,
  StudioSaveResult,
} from "./shared/studio/adapter.js";
import { NO_VALIDATION_ERRORS, type StudioValidationResult } from "./shared/studio/errorTaxonomy.js";
import {
  canDiscardTaskFields,
  computeTaskDirty,
  serializeTaskPatch,
  taskStudioTitleFor,
  type TaskDetailEntity,
  type TaskFields,
  type TaskPatch,
} from "./task-studio/domain.js";

export const TASK_STUDIO_DOMAIN_MESSAGE_NAMES = ["importImage", "importPrototype", "attachImage", "storeSketch", "attachmentStored"] as const;

/**
 * Presentation adapter only.  Persistence and Task semantics live behind WorkspaceTaskStudioTarget, whose
 * legacy and persistent implementations call the same service functions.  No editor surface retains a
 * concrete Workspace, TaskStore or attachment mutation path.
 */
export class TaskStudioAdapter implements StudioHostAdapter<TaskDetailEntity, TaskFields, TaskPatch> {
  entityType = "task";
  domainMessageNames = TASK_STUDIO_DOMAIN_MESSAGE_NAMES;
  concurrency = { kind: "cas" as const };
  allowPatchRestore = true;
  dirty = { computeDirty: computeTaskDirty, serializePatch: serializeTaskPatch, canDiscard: canDiscardTaskFields };

  constructor(private readonly target: WorkspaceTaskStudioTarget) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: TaskDetailEntity | undefined): string {
    return taskStudioTitleFor(mode, entityId, entity);
  }

  revisionOf(entity: TaskDetailEntity): string {
    return entity.expectUpdatedAt ?? "";
  }

  validate(_fields: TaskFields): StudioValidationResult {
    return NO_VALIDATION_ERRORS;
  }

  async load(entityId: string | undefined): Promise<StudioLoadResult<TaskDetailEntity>> {
    try {
      const entity = await this.target.loadTaskStudio(entityId);
      // t-610705 (Phase D, D2) — `expectUpdatedAt` is only ever absent from the projection
      // (taskStudioProjection.ts's `!task` branch) when `entityId` is a pre-minted id with no store
      // row yet — a task genuinely cannot exist in TaskStore without an `updatedAt`. This is the
      // `persisted` signal the studio host needs to gate `adapter.onCancel` correctly (see adapter.ts's
      // StudioLoadResult doc comment) — derived here, not threaded through the wire protocol, since
      // the projection already carries everything needed to compute it.
      return { status: "ok", entity, ...(entityId !== undefined ? { persisted: entity.expectUpdatedAt !== undefined } : {}) };
    }
    catch (error) { return { status: "error", error: errorMessage(error) }; }
  }

  save(entityId: string | undefined, patch: TaskPatch): Promise<StudioSaveResult> {
    return this.target.saveTaskStudio(entityId ?? mintTaskId(), patch);
  }

  async onCancel(entityId: string | undefined): Promise<void> {
    if (entityId === undefined) return;
    try { await this.target.cancelTaskStudio(entityId); }
    catch { /* provisional cleanup has always been best-effort; cancel must still close the editor */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
