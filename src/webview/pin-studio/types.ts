import type { StudioDomainMessage, StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol.js";
import type { PinDetailEntity, PinPatch } from "./domain.js";
import type { RichDocAssets, RichDocAttachmentVM, TiptapJSON } from "../rich-doc/types.js";

export type { TiptapJSON } from "../rich-doc/types.js";

/** spec 339 — pin-specific names alias the entity-neutral rich-doc VM types (extraction, no behavior change). */
export type PinStudioAttachmentVM = RichDocAttachmentVM;
export type PinStudioAssets = RichDocAssets;

export interface PinStudioVM {
  workspaceHash: string;
  folder: string;
  mode: "new" | "edit";
  pinId?: string;
  title: string;
  tags: string[];
  doc: TiptapJSON | null;
  attachments: PinStudioAttachmentVM[];
  assets: PinStudioAssets;
}

export type PinStudioHostMessage =
  | StudioHostCoreMessage<PinDetailEntity, string, PinPatch>
  | StudioDomainMessage<{ type: "attachmentStored"; attachment: PinStudioAttachmentVM }>;

export type PinStudioWebviewMessage =
  | StudioWebviewCoreMessage<PinPatch>
  | StudioDomainMessage<{ type: "importImage" }>
  | StudioDomainMessage<{ type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string }>
  | StudioDomainMessage<{
      type: "storeSketch";
      attachmentId?: string;
      name?: string;
      source: "blank" | "annotate-image";
      baseImageAttachmentId?: string;
      sceneJson: string;
      previewBase64: string;
    }>;
