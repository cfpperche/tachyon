import type { RichDocAttachment } from "../../richDoc/types.js";
import type { TiptapJSON } from "../../richDoc/types.js";
import type { RichDocAttachmentVM } from "./types.js";

export const EMPTY_DOC: TiptapJSON = { type: "doc", content: [{ type: "paragraph" }] };

export function toEditorDoc(doc: TiptapJSON | null, attachments: RichDocAttachmentVM[]): TiptapJSON {
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const byBlob = new Map(attachments.filter((a) => a.kind === "image").map((a) => [a.blobRef, a]));
  const visit = (node: TiptapJSON): TiptapJSON => {
    const attrs = node.attrs ? { ...node.attrs } : undefined;
    if (node.type === "image" && attrs) {
      const attachmentId = typeof attrs.attachmentId === "string" ? attrs.attachmentId : undefined;
      const blobRef = typeof attrs.blobRef === "string" ? attrs.blobRef : undefined;
      const att = (attachmentId ? byId.get(attachmentId) : undefined) ?? (blobRef ? byBlob.get(blobRef) : undefined);
      if (att?.uri) attrs.src = att.uri;
      if (att?.id) attrs.attachmentId = att.id;
      if (att?.kind === "image") attrs.blobRef = att.blobRef;
    }
    if (node.type === "tachyonSketch" && attrs) {
      const attachmentId = typeof attrs.attachmentId === "string" ? attrs.attachmentId : undefined;
      const att = attachmentId ? byId.get(attachmentId) : undefined;
      if (att?.kind === "excalidraw" && att.previewUri) attrs.previewSrc = att.previewUri;
    }
    return {
      ...node,
      ...(attrs ? { attrs } : {}),
      ...(node.content ? { content: node.content.map(visit) } : {}),
    };
  };
  return visit(doc ?? EMPTY_DOC);
}

export function toStoredDoc(doc: TiptapJSON): TiptapJSON {
  const visit = (node: TiptapJSON): TiptapJSON => {
    const attrs = node.attrs ? { ...node.attrs } : undefined;
    if (node.type === "image" && attrs) {
      const attachmentId = typeof attrs.attachmentId === "string" ? attrs.attachmentId : undefined;
      if (attachmentId) attrs.src = `tachyon-pin-attachment:${attachmentId}`;
    }
    if (node.type === "tachyonSketch" && attrs) {
      const attachmentId = typeof attrs.attachmentId === "string" ? attrs.attachmentId : undefined;
      if (attachmentId) {
        attrs.previewSrc = `tachyon-pin-sketch:${attachmentId}`;
      }
    }
    return {
      ...node,
      ...(attrs ? { attrs } : {}),
      ...(node.content ? { content: node.content.map(visit) } : {}),
    };
  };
  return visit(doc);
}

export function attachmentFromVM(att: RichDocAttachmentVM): RichDocAttachment {
  if (att.kind === "image") {
    const { path: _path, available: _available, uri: _uri, previewUri: _previewUri, sceneJson: _sceneJson, ...stored } = att;
    return stored;
  }
  const {
    scenePath: _scenePath,
    sceneAvailable: _sceneAvailable,
    previewPath: _previewPath,
    previewAvailable: _previewAvailable,
    uri: _uri,
    previewUri: _previewUri,
    sceneJson: _sceneJson,
    ...stored
  } = att;
  return stored;
}

export function attachmentsUsedByDoc(doc: TiptapJSON, attachments: RichDocAttachmentVM[]): RichDocAttachmentVM[] {
  const used = new Set<string>();
  const visit = (node: TiptapJSON): void => {
    if ((node.type === "image" || node.type === "tachyonSketch") && node.attrs) {
      const attachmentId = typeof node.attrs.attachmentId === "string" ? node.attrs.attachmentId : undefined;
      if (attachmentId) used.add(attachmentId);
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return attachments.filter((att) => used.has(att.id));
}

export function attachmentsForSave(doc: TiptapJSON, attachments: RichDocAttachmentVM[]): RichDocAttachmentVM[] {
  const used = new Set(attachmentsUsedByDoc(doc, attachments).map((att) => att.id));
  const byId = new Map(attachments.map((att) => [att.id, att]));
  for (const id of Array.from(used)) {
    const att = byId.get(id);
    if (att?.kind === "excalidraw" && att.baseImageAttachmentId) used.add(att.baseImageAttachmentId);
  }
  return attachments.filter((att) => used.has(att.id));
}

export function upsertAttachment(attachments: RichDocAttachmentVM[], attachment: RichDocAttachmentVM): RichDocAttachmentVM[] {
  return [...attachments.filter((att) => att.id !== attachment.id), attachment];
}
