export type PinAttachmentSource = "paste" | "drop" | "import";
export type PinSketchSource = "blank" | "annotate-image";

export interface PinImageAttachment {
  id: string;
  kind: "image";
  blobRef: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
  source: PinAttachmentSource;
  visibility: "local";
}

export interface PinExcalidrawAttachment {
  id: string;
  kind: "excalidraw";
  name: string;
  sceneBlobRef: string;
  previewBlobRef: string;
  sceneMediaType: "application/vnd.tachyon.excalidraw+json";
  previewMediaType: "image/png";
  sceneSize: number;
  previewSize: number;
  elementCount: number;
  createdAt: string;
  updatedAt: string;
  source: PinSketchSource;
  baseImageAttachmentId?: string;
  visibility: "local";
}

export type PinAttachment = PinImageAttachment | PinExcalidrawAttachment;

export interface ResolvedPinImageAttachment extends PinImageAttachment {
  path: string;
  available: boolean;
}

export interface ResolvedPinExcalidrawAttachment extends PinExcalidrawAttachment {
  scenePath: string;
  sceneAvailable: boolean;
  previewPath: string;
  previewAvailable: boolean;
}

export type ResolvedPinAttachment = ResolvedPinImageAttachment | ResolvedPinExcalidrawAttachment;

export interface TiptapJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapJSON[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}
