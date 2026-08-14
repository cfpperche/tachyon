import path from "node:path";
import {
  ALLOWED_IMAGE_TYPES,
  BLOB_SOFT_LIMIT_BYTES,
  EXCALIDRAW_SCENE_MEDIA_TYPE,
  IMAGE_MAX_BYTES,
  isBlobRef,
  RichDocAttachmentStore,
  safeDisplayComponent,
  type PutExcalidrawInput,
  type PutImageInput,
} from "../richDoc/AttachmentStore.js";
export type { PinAttachment, PinAttachmentSource, PinExcalidrawAttachment, PinSketchSource, ResolvedPinAttachment } from "./types.js";

/** spec 339 — the shared image/scene rules; kept under their historical `PIN_*` names (no behavior change). */
export const PIN_ALLOWED_IMAGE_TYPES = ALLOWED_IMAGE_TYPES;
export const PIN_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;
export const PIN_BLOB_SOFT_LIMIT_BYTES = BLOB_SOFT_LIMIT_BYTES;
export const PIN_EXCALIDRAW_SCENE_MEDIA_TYPE = EXCALIDRAW_SCENE_MEDIA_TYPE;

export type PutPinImageInput = PutImageInput;
export type PutPinExcalidrawInput = PutExcalidrawInput;
export type { NormalizedExcalidrawScene } from "../richDoc/AttachmentStore.js";

/** Local, content-addressed blob store for rich pin visual artifacts. */
export class PinAttachmentStore extends RichDocAttachmentStore {
  constructor(private readonly workspaceRoot: string) {
    super();
  }

  get pinDir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "pins");
  }

  get blobDir(): string {
    return path.join(this.pinDir, "blobs");
  }

  relativeBlobPath(blobRef: string): string {
    if (!isBlobRef(blobRef)) throw new Error(`invalid pin blob ref '${blobRef}'`);
    return `.tachyon/pins/blobs/${blobRef}`;
  }

  protected fallbackRelativePath(blobRef: string): string {
    return `.tachyon/pins/blobs/${safeDisplayComponent(blobRef)}`;
  }

  protected blobRefLabel(): string {
    return "pin blob ref";
  }
}

export function isPinBlobRef(value: string): boolean {
  return isBlobRef(value);
}
