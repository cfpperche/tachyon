import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import { mapStudioSubmitResult } from "./studioSubmit.js";
import { fromRunbookDef } from "@tachyon/engine/webview/formLogic.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "@tachyon/engine/webview/shared/studio/adapter.js";
import { NO_VALIDATION_ERRORS, type StudioValidationResult } from "./shared/studio/errorTaxonomy.js";
import {
  blankRunbookFields,
  canDiscardRunbookFields,
  computeRunbookDirty,
  serializeRunbookPatch,
  RUNBOOK_STUDIO_DOMAIN_MESSAGE_NAMES,
  runbookStudioTitleFor,
  type RunbookStudioEntity,
  type RunbookStudioFields,
  type RunbookStudioPatch,
  type RunbookStudioReferenceData,
} from "./runbook-studio-shell/domain.js";

export class RunbookStudioAdapter implements StudioHostAdapter<RunbookStudioEntity, RunbookStudioFields, RunbookStudioPatch, RunbookStudioReferenceData> {
  entityType = "runbook";
  domainMessageNames = RUNBOOK_STUDIO_DOMAIN_MESSAGE_NAMES;
  concurrency = { kind: "none" as const };
  allowPatchRestore = true;
  dirty = { computeDirty: computeRunbookDirty, serializePatch: serializeRunbookPatch, canDiscard: canDiscardRunbookFields };

  constructor(private readonly ws: WorkspaceStudioTarget) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: RunbookStudioEntity | undefined): string {
    return runbookStudioTitleFor(mode, entityId, entity);
  }

  load(entityId: string | undefined): StudioLoadResult<RunbookStudioEntity, RunbookStudioReferenceData> {
    const deps = this.ws.studioDeps();
    const referenceData: RunbookStudioReferenceData = {
      commandNames: deps.commandNames(),
    };
    if (entityId === undefined) {
      return { status: "ok", entity: { fields: blankRunbookFields() }, referenceData };
    }
    const def = this.ws.config?.runbooks[entityId];
    if (!def) return { status: "not-found" };
    return { status: "ok", entity: { name: entityId, fields: fromRunbookDef(entityId, def) }, referenceData };
  }

  validate(_fields: RunbookStudioFields): StudioValidationResult {
    return NO_VALIDATION_ERRORS;
  }

  save(entityId: string | undefined, patch: RunbookStudioPatch): StudioSaveResult | Promise<StudioSaveResult> {
    return mapStudioSubmitResult(
      this.ws.studioSubmit({ state: patch, editingName: entityId }),
      "validation/runbook-save-failed",
      entityId === undefined ? patch.name : undefined,
    );
  }
}
