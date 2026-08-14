import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import { mapStudioSubmitResult } from "./studioSubmit.js";
import { fromScheduleDef } from "@tachyon/engine/webview/formLogic.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "@tachyon/engine/webview/shared/studio/adapter.js";
import { NO_VALIDATION_ERRORS, type StudioValidationResult } from "./shared/studio/errorTaxonomy.js";
import {
  blankScheduleFields,
  canDiscardScheduleFields,
  computeScheduleDirty,
  serializeSchedulePatch,
  SCHEDULE_STUDIO_DOMAIN_MESSAGE_NAMES,
  scheduleStudioTitleFor,
  type ScheduleStudioEntity,
  type ScheduleStudioFields,
  type ScheduleStudioPatch,
  type ScheduleStudioReferenceData,
} from "./schedule-studio-shell/domain.js";

export class ScheduleStudioAdapter implements StudioHostAdapter<ScheduleStudioEntity, ScheduleStudioFields, ScheduleStudioPatch, ScheduleStudioReferenceData> {
  entityType = "schedule";
  domainMessageNames = SCHEDULE_STUDIO_DOMAIN_MESSAGE_NAMES;
  concurrency = { kind: "none" as const };
  allowPatchRestore = true;
  dirty = { computeDirty: computeScheduleDirty, serializePatch: serializeSchedulePatch, canDiscard: canDiscardScheduleFields };

  constructor(private readonly ws: WorkspaceStudioTarget) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: ScheduleStudioEntity | undefined): string {
    return scheduleStudioTitleFor(mode, entityId, entity);
  }

  load(entityId: string | undefined): StudioLoadResult<ScheduleStudioEntity, ScheduleStudioReferenceData> {
    const deps = this.ws.studioDeps();
    const referenceData: ScheduleStudioReferenceData = {
      commandNames: deps.commandNames(),
      runbookNames: Object.keys(this.ws.config?.runbooks ?? {}),
      agentNames: Object.keys(this.ws.config?.agents ?? {}),
    };
    if (entityId === undefined) {
      return { status: "ok", entity: { fields: blankScheduleFields() }, referenceData };
    }
    const def = this.ws.config?.schedules[entityId];
    if (!def) return { status: "not-found" };
    return { status: "ok", entity: { name: entityId, fields: fromScheduleDef(entityId, def) }, referenceData };
  }

  validate(_fields: ScheduleStudioFields): StudioValidationResult {
    return NO_VALIDATION_ERRORS;
  }

  save(entityId: string | undefined, patch: ScheduleStudioPatch): StudioSaveResult | Promise<StudioSaveResult> {
    return mapStudioSubmitResult(
      this.ws.studioSubmit({ state: patch, editingName: entityId }),
      "validation/schedule-save-failed",
      entityId === undefined ? patch.name : undefined,
    );
  }
}
