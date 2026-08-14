import { z } from "zod";
import type { PinAttachment } from "../pins/types.js";
import type { TiptapJSON } from "@tachyon/shared/richDoc/types.js";
import {
  isTiptapDoc,
  richDocAttachmentV1Schema,
  richDocImagePayloadV1Schema,
  richDocSketchPayloadV1Schema,
  type RichDocImagePayloadV1,
  type RichDocSketchPayloadV1,
} from "./richDocWire.js";
import { isStagedPayloadRefV1, type StagedPayloadRefV1 } from "./stagedPayload.js";

export const PIN_STUDIO_STAGED_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const PIN_STUDIO_TITLE_MAX_CHARS = 1024 * 1024;
const PIN_ID_RE = /^p-[0-9a-f]{6}$/;

export type PinStudioApplyActionV1 = "save" | "put-image" | "put-sketch";

export interface PinStudioApplyInputV1 {
  action: PinStudioApplyActionV1;
  pinId?: string;
  payload: StagedPayloadRefV1;
}

export interface PinStudioPatchV1 {
  title: string;
  tags: string[];
  doc: TiptapJSON;
  attachments: PinAttachment[];
  docDirty: boolean;
  expectUpdatedAt?: string;
}

export type PinStudioImagePayloadV1 = RichDocImagePayloadV1;
export type PinStudioSketchPayloadV1 = RichDocSketchPayloadV1;

export type PinStudioStagedPayloadV1 =
  | { schemaVersion: 1; patch: PinStudioPatchV1 }
  | PinStudioImagePayloadV1
  | PinStudioSketchPayloadV1;

const patch = z.object({
  title: z.string().max(PIN_STUDIO_TITLE_MAX_CHARS),
  tags: z.array(z.string().max(1_024)).max(100),
  doc: z.custom<TiptapJSON>(isTiptapDoc, "invalid bounded Tiptap document"),
  attachments: z.array(richDocAttachmentV1Schema).max(500),
  docDirty: z.boolean(),
  expectUpdatedAt: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.attachments.map((row) => row.id)).size !== value.attachments.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate pin attachments" });
  }
});
const savePayload = z.object({ schemaVersion: z.literal(1), patch }).strict();

export function isPinStudioApplyInputV1(value: unknown): value is PinStudioApplyInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<PinStudioApplyInputV1>;
  const keys = Object.keys(value);
  if (!keys.every((key) => key === "action" || key === "pinId" || key === "payload")
    || (keys.length !== 2 && keys.length !== 3)
    || (input.action !== "save" && input.action !== "put-image" && input.action !== "put-sketch")
    || !isStagedPayloadRefV1(input.payload)
    || (input.pinId !== undefined && (typeof input.pinId !== "string" || !PIN_ID_RE.test(input.pinId)))) return false;
  if (input.action === "put-image") return input.pinId === undefined && keys.length === 2;
  return (input.pinId === undefined) === (keys.length === 2);
}

export function parsePinStudioStagedPayloadV1(
  action: PinStudioApplyActionV1,
  bytes: Buffer,
): PinStudioStagedPayloadV1 {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength <= 0 || bytes.byteLength > PIN_STUDIO_STAGED_PAYLOAD_MAX_BYTES) {
    throw new Error("Pin Studio staged payload violates its byte limit");
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Pin Studio staged payload is not valid JSON"); }
  if (action === "save") return savePayload.parse(value) as { schemaVersion: 1; patch: PinStudioPatchV1 };
  if (action === "put-image") return richDocImagePayloadV1Schema.parse(value) as PinStudioImagePayloadV1;
  return richDocSketchPayloadV1Schema.parse(value) as PinStudioSketchPayloadV1;
}

export function encodePinStudioStagedPayloadV1(value: PinStudioStagedPayloadV1): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}
