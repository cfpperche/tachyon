import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import { mapStudioSubmitResult } from "./studioSubmit.js";
import { FLAG_SUGGESTIONS, fromCommandDef } from "./formLogic.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "./shared/studio/adapter.js";
import { NO_VALIDATION_ERRORS, type StudioValidationResult } from "./shared/studio/errorTaxonomy.js";
import {
  blankCommandFields,
  canDiscardCommandFields,
  computeCommandDirty,
  serializeCommandPatch,
  COMMAND_STUDIO_DOMAIN_MESSAGE_NAMES,
  commandStudioTitleFor,
  type CommandStudioEntity,
  type CommandStudioFields,
  type CommandStudioPatch,
  type CommandStudioReferenceData,
} from "./command-studio-shell/domain.js";

export class CommandStudioAdapter implements StudioHostAdapter<CommandStudioEntity, CommandStudioFields, CommandStudioPatch, CommandStudioReferenceData> {
  entityType = "command";
  domainMessageNames = COMMAND_STUDIO_DOMAIN_MESSAGE_NAMES;
  concurrency = { kind: "none" as const };
  allowPatchRestore = true;
  dirty = { computeDirty: computeCommandDirty, serializePatch: serializeCommandPatch, canDiscard: canDiscardCommandFields };

  constructor(private readonly ws: WorkspaceStudioTarget) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: CommandStudioEntity | undefined): string {
    return commandStudioTitleFor(mode, entityId, entity);
  }

  load(entityId: string | undefined): StudioLoadResult<CommandStudioEntity, CommandStudioReferenceData> {
    const deps = this.ws.studioDeps();
    const referenceData: CommandStudioReferenceData = {
      flagMap: FLAG_SUGGESTIONS,
      defaultCwd: deps.defaultCwd,
      verifyCandidates: deps.verifyCandidates(),
    };
    if (entityId === undefined) {
      return { status: "ok", entity: { fields: blankCommandFields() }, referenceData };
    }
    const def = this.ws.config?.commands[entityId];
    if (!def) return { status: "not-found" };
    return { status: "ok", entity: { name: entityId, fields: fromCommandDef(entityId, def) }, referenceData };
  }

  validate(_fields: CommandStudioFields): StudioValidationResult {
    return NO_VALIDATION_ERRORS;
  }

  save(entityId: string | undefined, patch: CommandStudioPatch): StudioSaveResult | Promise<StudioSaveResult> {
    return mapStudioSubmitResult(
      this.ws.studioSubmit({ state: patch, editingName: entityId }),
      "validation/command-save-failed",
      entityId === undefined ? patch.name : undefined,
    );
  }
}
