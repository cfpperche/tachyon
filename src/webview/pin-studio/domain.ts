import type { PinAttachment } from "../../pins/types.js";
import { isEmptyPinDoc } from "../../pins/pinStudioModel.js";
import { assertNoDomainNameCollision } from "../shared/studio/protocol.js";
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

export const isEmptyDoc = isEmptyPinDoc;

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
