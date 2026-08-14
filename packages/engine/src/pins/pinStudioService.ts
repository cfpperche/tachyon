import {
  decodeRichDocBase64,
  type RichDocImagePayloadV1,
  type RichDocSketchPayloadV1,
} from "../runtime-api/richDocWire.js";
import type { PinStudioPatchV1 } from "../runtime-api/pinStudioCommands.js";
import { PinAttachmentStore, PIN_BLOB_SOFT_LIMIT_BYTES } from "./PinAttachmentStore.js";
import type { PinStore } from "./PinStore.js";
import type { PinAttachment } from "./types.js";
import { isEmptyPinDoc } from "@tachyon/shared/pins/pinStudioModel.js";

export type PinStudioSaveServiceResult =
  | { status: "ok"; pinId: string }
  | { status: "conflict"; code: "CONFLICT"; message: string }
  | { status: "error"; code: "SAVE_FAILED"; message: string };

export interface PinStudioAttachmentServiceResult {
  attachment: PinAttachment;
  overSoftLimit: boolean;
}

export async function savePinStudio(
  pinStore: PinStore,
  pinId: string | undefined,
  patch: PinStudioPatchV1,
): Promise<PinStudioSaveServiceResult> {
  try {
    const title = patch.title.trim();
    const rich = !isEmptyPinDoc(patch.doc) || patch.attachments.length > 0;
    const staged = patch.expectUpdatedAt === undefined;
    if (pinId && !staged) {
      const current = pinStore.readDetail(pinId).summary;
      const revision = current.updatedAt ?? current.createdAt;
      if (patch.expectUpdatedAt !== revision) {
        return { status: "conflict", code: "CONFLICT", message: "Pin changed since this draft was opened. Reload before saving." };
      }
    }
    const pin = pinId && !staged
      ? rich
        ? await pinStore.saveDetail(pinId, { text: title, tags: patch.tags, doc: patch.doc, attachments: patch.attachments })
        : await pinStore.clearDetail(pinId, title, new Date().toISOString(), patch.tags)
      : rich
        ? await pinStore.createRich(title, "human", { id: pinId, tags: patch.tags, doc: patch.doc, attachments: patch.attachments })
        : await pinStore.create(title, "human", { id: pinId, tags: patch.tags });
    return { status: "ok", pinId: pin.id };
  } catch (error) {
    return { status: "error", code: "SAVE_FAILED", message: errorMessage(error) };
  }
}

export function putPinStudioImage(
  workspaceRoot: string,
  payload: RichDocImagePayloadV1,
): PinStudioAttachmentServiceResult {
  const store = new PinAttachmentStore(workspaceRoot);
  const attachment = store.putImage({
    data: decodeRichDocBase64(payload.dataBase64, "pin image"),
    mediaType: payload.mediaType,
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    source: payload.source,
  });
  return { attachment, overSoftLimit: store.totalBlobBytes() > PIN_BLOB_SOFT_LIMIT_BYTES };
}

export function putPinStudioSketch(
  workspaceRoot: string,
  pinStore: PinStore,
  pinId: string | undefined,
  payload: RichDocSketchPayloadV1,
): PinStudioAttachmentServiceResult {
  const store = new PinAttachmentStore(workspaceRoot);
  const existing = pinId && payload.attachmentId
    ? pinStore.readDetail(pinId).attachments.find((attachment) => attachment.kind === "excalidraw" && attachment.id === payload.attachmentId)
    : undefined;
  const attachment = store.putExcalidraw({
    sceneJson: payload.sceneJson,
    previewData: decodeRichDocBase64(payload.previewBase64, "pin sketch preview"),
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    source: payload.source,
    ...(payload.baseImageAttachmentId !== undefined ? { baseImageAttachmentId: payload.baseImageAttachmentId } : {}),
    ...(existing?.kind === "excalidraw" ? { existing } : {}),
  });
  return { attachment, overSoftLimit: store.totalBlobBytes() > PIN_BLOB_SOFT_LIMIT_BYTES };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
