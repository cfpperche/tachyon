import type { WorkspacePinStudioTarget } from "../shell/PinStudioTarget.js";
import type { StudioHostAdapter } from "./shared/studio/adapter.js";
import { NO_VALIDATION_ERRORS, type StudioValidationResult } from "./shared/studio/errorTaxonomy.js";
import {
  PIN_STUDIO_DOMAIN_MESSAGE_NAMES,
  canDiscardPinFields,
  computePinDirty,
  pinStudioTitleFor,
  serializePinPatch,
  type PinDetailEntity,
  type PinFields,
  type PinPatch,
} from "./pin-studio/domain.js";

/** Presentation adapter only; Pin persistence and media mutation live behind WorkspacePinStudioTarget. */
export class PinStudioAdapter implements StudioHostAdapter<PinDetailEntity, PinFields, PinPatch> {
  readonly entityType = "pin";
  readonly domainMessageNames = PIN_STUDIO_DOMAIN_MESSAGE_NAMES;
  readonly concurrency = { kind: "cas" } as const;
  readonly revisionOf = (entity: PinDetailEntity): string => entity.expectUpdatedAt ?? "";
  readonly allowPatchRestore = true;

  readonly dirty = {
    computeDirty: computePinDirty,
    serializePatch: serializePinPatch,
    canDiscard: canDiscardPinFields,
  };

  constructor(private readonly target: WorkspacePinStudioTarget) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: PinDetailEntity | undefined): string {
    return pinStudioTitleFor(mode, entityId, entity);
  }

  async load(entityId: string | undefined) {
    try {
      const entity = await this.target.loadPinStudio(entityId);
      return { status: "ok" as const, entity };
    } catch (error) {
      return { status: "error" as const, error: error instanceof Error ? error.message : String(error) };
    }
  }

  validate(fields: PinFields): StudioValidationResult {
    return fields.title.trim()
      ? NO_VALIDATION_ERRORS
      : { blocking: [{ code: "pin/title-required", message: "Pin title is required", source: "validation", blocking: true }], nonBlocking: [] };
  }

  save(entityId: string | undefined, patch: PinPatch) {
    return this.target.savePinStudio(entityId, patch);
  }
}
