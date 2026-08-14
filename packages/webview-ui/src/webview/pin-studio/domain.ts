import type { PinAttachment } from "@tachyon/engine/pins/types.js";
import { isEmptyPinDoc } from "@tachyon/shared/pins/pinStudioModel.js";
import { assertNoDomainNameCollision } from "../shared/studio/protocol.js";
import type { PinStudioAttachmentVM, TiptapJSON } from "./types.js";

export const PIN_STUDIO_DOMAIN_MESSAGE_NAMES = ["attachImage", "storeSketch", "attachmentStored"] as const;
assertNoDomainNameCollision(PIN_STUDIO_DOMAIN_MESSAGE_NAMES);

/** t-610705 (Phase D, D3) — the host->webview-only subset of the names above, browser-safe (no
 *  `assertNoDomainNameCollision`'s Node-side import chain) — mirrors task-studio/domain.ts's
 *  TASK_STUDIO_HOST_MESSAGE_NAMES split. Pin Studio's only inbound domain push is the same
 *  "attachmentStored" (import/attach/storeSketch results) every rich-doc-based studio shares. */
export const PIN_STUDIO_HOST_MESSAGE_NAMES = ["attachmentStored"] as const;

export interface PinDetailEntity {
  workspaceHash: string;
  folder: string;
  pinId?: string;
  title: string;
  tags: string[];
  doc: TiptapJSON | null;
  attachments: PinStudioAttachmentVM[];
  /** CAS baseline inherited by the unified Pin document from D12's task-document policy. */
  expectUpdatedAt?: string;
}

export interface PinFields {
  title: string;
  tags: string[];
  doc: TiptapJSON;
  attachments: PinAttachment[];
  docDirty: boolean;
  /** The revision loaded when this draft began; host refreshes never advance a dirty draft's base. */
  expectUpdatedAt?: string;
}

export type PinPatch = PinFields;

export function pinStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: PinDetailEntity | undefined): string {
  if (mode === "new") return entity?.folder ? `New Pin — ${entity.folder}` : "New Pin";
  return `Pin Studio — ${entity?.pinId ?? entityId ?? ""}`;
}

/**
 * t-cdd4e1 — `fields.docDirty` is an EXPLICIT flag (set only by TipTap's own `onUpdate` firing), not a
 * structural diff of `fields.doc` against the loaded entity's doc: TipTap's `editor.getJSON()` does
 * not round-trip byte-for-byte through `setContent()` (extension-added default attrs, etc.), so a
 * JSON.stringify comparison against the raw seed doc read as dirty from the moment of mount, before
 * any edit — mirrors task-studio/domain.ts's `computeTaskDirty`, which uses the same explicit-flag
 * pattern for exactly this reason.
 */
export function computePinDirty(entity: PinDetailEntity | undefined, fields: PinFields): boolean {
  if (!entity) return false;
  return (
    fields.title.trim() !== entity.title ||
    JSON.stringify(fields.tags) !== JSON.stringify(entity.tags) ||
    fields.docDirty ||
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
