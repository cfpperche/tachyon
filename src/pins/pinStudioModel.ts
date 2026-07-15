import type { TiptapJSON } from "../richDoc/types.js";

export function isEmptyPinDoc(doc: TiptapJSON): boolean {
  const content = doc.content ?? [];
  if (content.length === 0) return true;
  if (content.length !== 1) return false;
  const only = content[0];
  return only?.type === "paragraph" && (!only.content || only.content.length === 0);
}
