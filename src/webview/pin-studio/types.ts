import type { PinAttachment, ResolvedPinAttachment, TiptapJSON } from "../../pins/types";

export type PinStudioAttachmentVM = ResolvedPinAttachment & {
  uri?: string;
  previewUri?: string;
  sceneJson?: string;
};

export interface PinStudioAssets {
  excalidrawScriptUri: string;
  excalidrawCssUri: string;
  excalidrawAssetPath: string;
}

export interface PinStudioVM {
  workspaceHash: string;
  folder: string;
  mode: "new" | "edit";
  pinId?: string;
  title: string;
  doc: TiptapJSON | null;
  attachments: PinStudioAttachmentVM[];
  assets: PinStudioAssets;
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
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string }
  | {
      type: "storeSketch";
      attachmentId?: string;
      name?: string;
      source: "blank" | "annotate-image";
      baseImageAttachmentId?: string;
      sceneJson: string;
      previewBase64: string;
    };
