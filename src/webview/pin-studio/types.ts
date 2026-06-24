import type { PinAttachment, ResolvedPinAttachment, TiptapJSON } from "../../pins/types";

export interface PinStudioAttachmentVM extends ResolvedPinAttachment {
  uri?: string;
}

export interface PinStudioVM {
  workspaceHash: string;
  folder: string;
  mode: "new" | "edit";
  pinId?: string;
  title: string;
  doc: TiptapJSON | null;
  attachments: PinStudioAttachmentVM[];
}

export type PinStudioHostMessage =
  | { type: "pinStudio"; vm: PinStudioVM }
  | { type: "attachmentStored"; attachment: PinStudioAttachmentVM }
  | { type: "error"; message: string };

export type PinStudioWebviewMessage =
  | { type: "ready" }
  | { type: "cancel" }
  | { type: "importImage" }
  | { type: "save"; title: string; doc: TiptapJSON; attachments: PinAttachment[] }
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string };
