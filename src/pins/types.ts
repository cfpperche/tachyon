export type PinAttachmentSource = "paste" | "drop" | "import";

export interface PinAttachment {
  id: string;
  kind: "image";
  blobRef: string;
  mediaType: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
  source: PinAttachmentSource;
  visibility: "local";
}

export interface ResolvedPinAttachment extends PinAttachment {
  path: string;
  available: boolean;
}

export interface TiptapJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapJSON[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}
