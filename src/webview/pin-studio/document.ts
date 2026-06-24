import type { PinAttachment, TiptapJSON } from "../../pins/types";
import type { PinStudioAttachmentVM } from "./types";

export const EMPTY_DOC: TiptapJSON = { type: "doc", content: [{ type: "paragraph" }] };

export function toEditorDoc(doc: TiptapJSON | null, attachments: PinStudioAttachmentVM[]): TiptapJSON {
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const byBlob = new Map(attachments.map((a) => [a.blobRef, a]));
  const visit = (node: TiptapJSON): TiptapJSON => {
    const attrs = node.attrs ? { ...node.attrs } : undefined;
    if (node.type === "image" && attrs) {
      const attachmentId = typeof attrs.attachmentId === "string" ? attrs.attachmentId : undefined;
      const blobRef = typeof attrs.blobRef === "string" ? attrs.blobRef : undefined;
      const att = (attachmentId ? byId.get(attachmentId) : undefined) ?? (blobRef ? byBlob.get(blobRef) : undefined);
      if (att?.uri) attrs.src = att.uri;
      if (att?.id) attrs.attachmentId = att.id;
      if (att?.blobRef) attrs.blobRef = att.blobRef;
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
    return {
      ...node,
      ...(attrs ? { attrs } : {}),
      ...(node.content ? { content: node.content.map(visit) } : {}),
    };
  };
  return visit(doc);
}

export function attachmentFromVM(att: PinStudioAttachmentVM): PinAttachment {
  const { path: _path, available: _available, uri: _uri, ...stored } = att;
  return stored;
}
