import { z } from "zod";
import type { PinAttachment, ResolvedPinAttachment } from "../pins/types.js";
import type { PinStore } from "../pins/PinStore.js";
import type { TiptapJSON } from "../richDoc/types.js";
import {
  isTiptapDoc,
  persistedRichDocAttachmentV1Schema,
} from "./richDocWire.js";

const projection = z.object({
  schemaVersion: z.literal(1),
  pinId: z.string().regex(/^p-[0-9a-f]{6}$/),
  title: z.string().min(1),
  tags: z.array(z.string().min(1)),
  doc: z.union([z.custom<TiptapJSON>(isTiptapDoc, "invalid bounded Tiptap document"), z.null()]),
  attachments: z.array(persistedRichDocAttachmentV1Schema).max(500),
}).strict().superRefine((value, context) => {
  if (new Set(value.tags).size !== value.tags.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate pin tags" });
  }
  if (new Set(value.attachments.map((row) => row.id)).size !== value.attachments.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate pin attachments" });
  }
});

export type PinStudioProjectionV1 = z.infer<typeof projection>;

export interface PinStudioViewV1 {
  schemaVersion: 1;
  studio: PinStudioProjectionV1;
}

export function parsePinStudioProjectionV1(value: unknown): PinStudioProjectionV1 {
  return projection.parse(value);
}

export function parsePinStudioViewV1(value: unknown): PinStudioViewV1 {
  return z.object({ schemaVersion: z.literal(1), studio: projection }).strict().parse(value);
}

export function isPinStudioViewV1(value: unknown): value is PinStudioViewV1 {
  return z.object({ schemaVersion: z.literal(1), studio: projection }).strict().safeParse(value).success;
}

export function projectPinStudio(store: PinStore, id: string): PinStudioProjectionV1 {
  if (!/^p-[0-9a-f]{6}$/.test(id)) throw new Error(`invalid pin id '${id}'`);
  const detail = store.readDetail(id);
  return parsePinStudioProjectionV1({
    schemaVersion: 1,
    pinId: id,
    title: detail.summary.text,
    tags: detail.summary.tags ?? [],
    doc: detail.doc,
    attachments: detail.attachments.map(storedAttachment),
  });
}

function storedAttachment(attachment: ResolvedPinAttachment): PinAttachment {
  if (attachment.kind === "image") {
    const { path: _path, available: _available, ...stored } = attachment;
    return stored;
  }
  const {
    scenePath: _scenePath,
    sceneAvailable: _sceneAvailable,
    previewPath: _previewPath,
    previewAvailable: _previewAvailable,
    ...stored
  } = attachment;
  return stored;
}
