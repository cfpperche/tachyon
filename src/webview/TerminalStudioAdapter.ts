import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import { terminalsOf } from "@tachyon/engine/config/loadConfig.js";
import { mapStudioSubmitResult } from "./studioSubmit.js";
import { FLAG_SUGGESTIONS, fromTerminalDef } from "@tachyon/engine/webview/formLogic.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "@tachyon/engine/webview/shared/studio/adapter.js";
import { NO_VALIDATION_ERRORS, type StudioValidationResult } from "./shared/studio/errorTaxonomy.js";
import {
  blankTerminalFields,
  canDiscardTerminalFields,
  computeTerminalDirty,
  serializeTerminalPatch,
  TERMINAL_STUDIO_DOMAIN_MESSAGE_NAMES,
  terminalStudioTitleFor,
  type TerminalStudioEntity,
  type TerminalStudioFields,
  type TerminalStudioPatch,
  type TerminalStudioReferenceData,
} from "./terminal-studio-shell/domain.js";

export class TerminalStudioAdapter implements StudioHostAdapter<TerminalStudioEntity, TerminalStudioFields, TerminalStudioPatch, TerminalStudioReferenceData> {
  entityType = "terminal";
  domainMessageNames = TERMINAL_STUDIO_DOMAIN_MESSAGE_NAMES;
  concurrency = { kind: "none" as const };
  allowPatchRestore = true;
  dirty = { computeDirty: computeTerminalDirty, serializePatch: serializeTerminalPatch, canDiscard: canDiscardTerminalFields };

  constructor(private readonly ws: WorkspaceStudioTarget) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: TerminalStudioEntity | undefined): string {
    return terminalStudioTitleFor(mode, entityId, entity);
  }

  load(entityId: string | undefined): StudioLoadResult<TerminalStudioEntity, TerminalStudioReferenceData> {
    const deps = this.ws.studioDeps();
    const referenceData: TerminalStudioReferenceData = {
      flagMap: FLAG_SUGGESTIONS,
      defaultCwd: deps.defaultCwd,
    };
    if (entityId === undefined) {
      return { status: "ok", entity: { fields: blankTerminalFields() }, referenceData };
    }
    const def = terminalsOf(this.ws.config)[entityId];
    if (!def) return { status: "not-found" };
    return { status: "ok", entity: { name: entityId, fields: fromTerminalDef(entityId, def) }, referenceData };
  }

  validate(_fields: TerminalStudioFields): StudioValidationResult {
    return NO_VALIDATION_ERRORS;
  }

  save(entityId: string | undefined, patch: TerminalStudioPatch): StudioSaveResult | Promise<StudioSaveResult> {
    return mapStudioSubmitResult(
      this.ws.studioSubmit({ state: patch, editingName: entityId }),
      "validation/terminal-save-failed",
      entityId === undefined ? patch.name : undefined,
    );
  }
}
