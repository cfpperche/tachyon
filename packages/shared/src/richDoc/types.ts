/**
 * spec 339 — entity-neutral rich-doc types, extracted from `src/pins/types.ts` so both pins and tasks
 * (host stores + webview editor stack) share one definition. No vscode dependency; safe for host and
 * webview code alike. `src/pins/types.ts` re-exports these under its historical `Pin*` names so existing
 * pin call sites are unaffected by the extraction.
 */

export type AttachmentSource = "paste" | "drop" | "import";
export type SketchSource = "blank" | "annotate-image";

export interface ImageAttachment {
  id: string;
  kind: "image";
  blobRef: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
  source: AttachmentSource;
  visibility: "local";
}

export interface ExcalidrawAttachment {
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
  source: SketchSource;
  baseImageAttachmentId?: string;
  visibility: "local";
}

export type RichDocAttachment = ImageAttachment | ExcalidrawAttachment;

export interface ResolvedImageAttachment extends ImageAttachment {
  path: string;
  available: boolean;
}

export interface ResolvedExcalidrawAttachment extends ExcalidrawAttachment {
  scenePath: string;
  sceneAvailable: boolean;
  previewPath: string;
  previewAvailable: boolean;
}

export type ResolvedRichDocAttachment = ResolvedImageAttachment | ResolvedExcalidrawAttachment;

export interface TiptapJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapJSON[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}
