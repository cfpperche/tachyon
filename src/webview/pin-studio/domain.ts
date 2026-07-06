import type { Workspace } from "../../workspace/Workspace.js";
import { PinAttachmentStore } from "../../pins/PinAttachmentStore.js";
import type { PinAttachment } from "../../pins/types.js";
import type { ResolvedRichDocAttachment } from "../../richDoc/types.js";
import type { StudioHostAdapter, StudioLoadContext } from "../shared/studio/adapter.js";
import { assertNoDomainNameCollision } from "../shared/studio/protocol.js";
import { NO_VALIDATION_ERRORS, type StudioValidationResult } from "../shared/studio/errorTaxonomy.js";
import type { PinStudioAttachmentVM, TiptapJSON } from "./types.js";

export const PIN_STUDIO_DOMAIN_MESSAGE_NAMES = ["importImage", "attachImage", "storeSketch", "attachmentStored"] as const;
assertNoDomainNameCollision(PIN_STUDIO_DOMAIN_MESSAGE_NAMES);

export interface PinDetailEntity {
  workspaceHash: string;
  folder: string;
  pinId?: string;
  title: string;
  tags: string[];
  doc: TiptapJSON | null;
  attachments: PinStudioAttachmentVM[];
}

export interface PinFields {
  title: string;
  tags: string[];
  doc: TiptapJSON;
  attachments: PinAttachment[];
}

export type PinPatch = PinFields;

export function pinStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: PinDetailEntity | undefined): string {
  if (mode === "new") return entity?.folder ? `New Pin — ${entity.folder}` : "New Pin";
  return `Pin Studio — ${entity?.pinId ?? entityId ?? ""}`;
}

export function computePinDirty(entity: PinDetailEntity | undefined, fields: PinFields): boolean {
  if (!entity) return false;
  return (
    fields.title.trim() !== entity.title ||
    JSON.stringify(fields.tags) !== JSON.stringify(entity.tags) ||
    JSON.stringify(fields.doc) !== JSON.stringify(entity.doc ?? emptyDoc()) ||
    JSON.stringify(fields.attachments) !== JSON.stringify(entity.attachments.map(stripAttachmentVm))
  );
}

export function serializePinPatch(fields: PinFields, dirty: boolean): PinPatch | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardPinFields(fields: PinFields): boolean {
  return !fields.title.trim() && fields.tags.length === 0 && isEmptyDoc(fields.doc) && fields.attachments.length === 0;
}

export function isEmptyDoc(doc: TiptapJSON): boolean {
  const content = doc.content ?? [];
  if (content.length === 0) return true;
  if (content.length !== 1) return false;
  const only = content[0];
  return only?.type === "paragraph" && (!only.content || only.content.length === 0);
}

export class PinStudioAdapter implements StudioHostAdapter<PinDetailEntity, PinFields, PinPatch> {
  readonly entityType = "pin";
  readonly domainMessageNames = PIN_STUDIO_DOMAIN_MESSAGE_NAMES;
  readonly concurrency = { kind: "none" } as const;
  readonly allowPatchRestore = true;
  private pendingInitialTitle = "";

  readonly dirty = {
    computeDirty: computePinDirty,
    serializePatch: serializePinPatch,
    canDiscard: canDiscardPinFields,
  };

  constructor(private readonly ws: Workspace) {}

  setInitialTitle(title: string): void {
    this.pendingInitialTitle = title;
  }

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: PinDetailEntity | undefined): string {
    return pinStudioTitleFor(mode, entityId, entity);
  }

  load(entityId: string | undefined, context?: StudioLoadContext) {
    if (!entityId) {
      return {
        status: "ok" as const,
        entity: {
          workspaceHash: this.ws.wsHash,
          folder: this.ws.folderName,
          title: this.pendingInitialTitle,
          tags: [],
          doc: null,
          attachments: [],
        },
      };
    }
    try {
      const detail = this.ws.pinStore.readDetail(entityId);
      return {
        status: "ok" as const,
        entity: {
          workspaceHash: this.ws.wsHash,
          folder: this.ws.folderName,
          pinId: entityId,
          title: detail.summary.text,
          tags: detail.summary.tags ?? [],
          doc: detail.doc,
          attachments: resolveAttachmentsForWebview(detail.attachments, new PinAttachmentStore(this.ws.workspaceRoot), context),
        },
      };
    } catch (err) {
      return { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
    }
  }

  validate(fields: PinFields): StudioValidationResult {
    return fields.title.trim()
      ? NO_VALIDATION_ERRORS
      : { blocking: [{ code: "pin/title-required", message: "Pin title is required", source: "validation", blocking: true }], nonBlocking: [] };
  }

  save(entityId: string | undefined, patch: PinPatch) {
    try {
      const title = patch.title.trim();
      const rich = !isEmptyDoc(patch.doc) || patch.attachments.length > 0;
      const tags = patch.tags ?? [];
      if (entityId) {
        if (rich) this.ws.pinStore.saveDetail(entityId, { text: title, tags, doc: patch.doc, attachments: patch.attachments });
        else this.ws.pinStore.clearDetail(entityId, title, new Date().toISOString(), tags);
      } else if (rich) {
        this.ws.pinStore.createRich(title, "human", { tags, doc: patch.doc, attachments: patch.attachments });
      } else {
        this.ws.pinStore.create(title, "human", { tags });
      }
      return { status: "ok" as const };
    } catch (err) {
      return {
        status: "error" as const,
        error: {
          code: "pin/save-failed",
          message: err instanceof Error ? err.message : String(err),
          source: "persistence" as const,
        },
      };
    }
  }
}

function emptyDoc(): TiptapJSON {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function stripAttachmentVm(att: PinStudioAttachmentVM): PinAttachment {
  if (att.kind === "image") {
    const { path: _path, available: _available, uri: _uri, ...stored } = att;
    return stored;
  }
  const {
    scenePath: _scenePath,
    sceneAvailable: _sceneAvailable,
    previewPath: _previewPath,
    previewAvailable: _previewAvailable,
    previewUri: _previewUri,
    sceneJson: _sceneJson,
    ...stored
  } = att;
  return stored;
}

function resolveAttachmentsForWebview(attachments: ResolvedRichDocAttachment[], store: PinAttachmentStore, context: StudioLoadContext | undefined): PinStudioAttachmentVM[] {
  return attachments.map((att) => {
    if (att.kind === "excalidraw") {
      return {
        ...att,
        ...(att.previewAvailable ? { previewUri: context?.asWebviewUri(store.blobPath(att.previewBlobRef)) ?? store.blobPath(att.previewBlobRef) } : {}),
        ...(att.sceneAvailable ? { sceneJson: store.readExcalidrawScene(att) } : {}),
      };
    }
    return {
      ...att,
      ...(att.available ? { uri: context?.asWebviewUri(store.blobPath(att.blobRef)) ?? store.blobPath(att.blobRef) } : {}),
    };
  });
}
