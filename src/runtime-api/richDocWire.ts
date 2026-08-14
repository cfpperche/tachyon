import { z } from "zod";
import type { TiptapJSON } from "@tachyon/shared/richDoc/types.js";

export const RICH_DOC_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const RICH_DOC_SCENE_INPUT_MAX_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(RICH_DOC_IMAGE_MAX_BYTES / 3) * 4;
const ATTACHMENT_ID_RE = /^att-[0-9a-f]{6}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_DOC_NODES = 100_000;
const MAX_DOC_DEPTH = 64;

const timestamp = z.string().max(64).refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");
const nonEmptyText = (max: number) => z.string().min(1).max(max);

function attachmentName(authoring: boolean) { return authoring ? nonEmptyText(500) : z.string().min(1); }
function attachmentSize(max: number, authoring: boolean, positive = false) {
  const base = positive ? z.number().int().positive() : z.number().int().nonnegative();
  return authoring ? base.max(max) : base;
}

function imageAttachmentSchema(authoring: boolean) { return z.object({
  id: z.string().regex(ATTACHMENT_ID_RE),
  kind: z.literal("image"),
  blobRef: z.string().regex(SHA256_RE),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  name: attachmentName(authoring),
  size: attachmentSize(RICH_DOC_IMAGE_MAX_BYTES, authoring),
  width: z.number().int().positive().max(1_000_000).optional(),
  height: z.number().int().positive().max(1_000_000).optional(),
  createdAt: timestamp,
  source: z.enum(["paste", "drop", "import"]),
  visibility: z.literal("local"),
}).strict(); }

function sketchAttachmentSchema(authoring: boolean) { return z.object({
  id: z.string().regex(ATTACHMENT_ID_RE),
  kind: z.literal("excalidraw"),
  name: attachmentName(authoring),
  sceneBlobRef: z.string().regex(SHA256_RE),
  previewBlobRef: z.string().regex(SHA256_RE),
  sceneMediaType: z.literal("application/vnd.tachyon.excalidraw+json"),
  previewMediaType: z.literal("image/png"),
  sceneSize: attachmentSize(64 * 1024 * 1024, authoring, true),
  previewSize: attachmentSize(RICH_DOC_IMAGE_MAX_BYTES, authoring),
  elementCount: z.number().int().nonnegative().max(1_000_000),
  createdAt: timestamp,
  updatedAt: timestamp,
  source: z.enum(["blank", "annotate-image"]),
  baseImageAttachmentId: z.string().regex(ATTACHMENT_ID_RE).optional(),
  visibility: z.literal("local"),
}).strict(); }

export const richDocAttachmentV1Schema = z.discriminatedUnion("kind", [imageAttachmentSchema(true), sketchAttachmentSchema(true)]);
export const persistedRichDocAttachmentV1Schema = z.discriminatedUnion("kind", [imageAttachmentSchema(false), sketchAttachmentSchema(false)]);

export interface RichDocImagePayloadV1 {
  schemaVersion: 1;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name?: string;
  source: "paste" | "drop" | "import";
  dataBase64: string;
}

export interface RichDocSketchPayloadV1 {
  schemaVersion: 1;
  attachmentId?: string;
  name?: string;
  source: "blank" | "annotate-image";
  baseImageAttachmentId?: string;
  sceneJson: string;
  previewBase64: string;
}

export const richDocImagePayloadV1Schema = z.object({
  schemaVersion: z.literal(1),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  name: z.string().max(500).optional(),
  source: z.enum(["paste", "drop", "import"]),
  dataBase64: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS).refine(isCanonicalBase64, "image payload is not canonical base64"),
}).strict();

export const richDocSketchPayloadV1Schema = z.object({
  schemaVersion: z.literal(1),
  attachmentId: z.string().regex(ATTACHMENT_ID_RE).optional(),
  name: z.string().max(500).optional(),
  source: z.enum(["blank", "annotate-image"]),
  baseImageAttachmentId: z.string().regex(ATTACHMENT_ID_RE).optional(),
  sceneJson: boundedBytes(RICH_DOC_SCENE_INPUT_MAX_BYTES, "Excalidraw scene"),
  previewBase64: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS).refine(isCanonicalBase64, "sketch preview is not canonical base64"),
}).strict();

export function decodeRichDocBase64(value: string, label: string): Buffer {
  if (!isCanonicalBase64(value)) throw new Error(`${label} is not canonical base64`);
  const data = Buffer.from(value, "base64");
  if (data.byteLength > RICH_DOC_IMAGE_MAX_BYTES) throw new Error(`${label} exceeds 10 MB`);
  return data;
}

export function isTiptapDoc(value: unknown): value is TiptapJSON {
  if (!isFiniteJsonTree(value, MAX_DOC_DEPTH, MAX_DOC_NODES) || !isRecord(value)) return false;
  const stack: Array<{ node: Record<string, unknown>; depth: number }> = [{ node: value, depth: 0 }];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    count += 1;
    if (count > MAX_DOC_NODES || current.depth > MAX_DOC_DEPTH) return false;
    if (!Object.keys(current.node).every((key) => key === "type" || key === "attrs" || key === "content" || key === "text" || key === "marks")) return false;
    if (typeof current.node.type !== "string" || current.node.type.length === 0 || current.node.type.length > 64) return false;
    if (current.node.attrs !== undefined && !isRecord(current.node.attrs)) return false;
    if (current.node.text !== undefined && (typeof current.node.text !== "string" || current.node.text.length > 16 * 1024 * 1024)) return false;
    if (current.node.marks !== undefined) {
      if (!Array.isArray(current.node.marks) || current.node.marks.length > 128) return false;
      for (const mark of current.node.marks) {
        if (!isRecord(mark)
          || !Object.keys(mark).every((key) => key === "type" || key === "attrs")
          || typeof mark.type !== "string" || mark.type.length === 0 || mark.type.length > 64
          || (mark.attrs !== undefined && !isRecord(mark.attrs))) return false;
      }
    }
    if (current.node.content !== undefined) {
      if (!Array.isArray(current.node.content) || current.node.content.length > MAX_DOC_NODES) return false;
      for (const child of current.node.content) {
        if (!isRecord(child)) return false;
        stack.push({ node: child, depth: current.depth + 1 });
      }
    }
  }
  return value.type === "doc";
}

function boundedBytes(max: number, label: string) {
  return z.string().refine((value) => Buffer.byteLength(value, "utf8") <= max, `${label} exceeds ${max} bytes`);
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try { return Buffer.from(value, "base64").toString("base64") === value; }
  catch { return false; }
}

function isFiniteJsonTree(value: unknown, maxDepth: number, maxNodes: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    count += 1;
    if (count > maxNodes || current.depth > maxDepth) return false;
    const nested = current.value;
    if (nested === null || typeof nested === "string" || typeof nested === "boolean") continue;
    if (typeof nested === "number") { if (!Number.isFinite(nested)) return false; continue; }
    if (Array.isArray(nested)) {
      for (const item of nested) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(nested)) return false;
    for (const [key, item] of Object.entries(nested)) {
      if (key.length > 256) return false;
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
