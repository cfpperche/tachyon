/**
 * spec 339 — pin-specific names now alias the entity-neutral rich-doc types in `src/richDoc/types.ts`
 * (extracted so tasks can share the same doc/attachment shapes). Pure type re-export/rename: no runtime
 * behavior change, every existing `Pin*` import keeps resolving exactly as before.
 */
export type {
  AttachmentSource as PinAttachmentSource,
  SketchSource as PinSketchSource,
  ImageAttachment as PinImageAttachment,
  ExcalidrawAttachment as PinExcalidrawAttachment,
  RichDocAttachment as PinAttachment,
  ResolvedImageAttachment as ResolvedPinImageAttachment,
  ResolvedExcalidrawAttachment as ResolvedPinExcalidrawAttachment,
  ResolvedRichDocAttachment as ResolvedPinAttachment,
  TiptapJSON,
} from "@tachyon/shared/richDoc/types.js";
