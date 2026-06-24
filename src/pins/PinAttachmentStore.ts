import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  PinAttachment,
  PinAttachmentSource,
  PinExcalidrawAttachment,
  PinImageAttachment,
  PinSketchSource,
  ResolvedPinAttachment,
} from "./types.js";

export type { PinAttachment, PinAttachmentSource, PinExcalidrawAttachment, PinSketchSource, ResolvedPinAttachment } from "./types.js";

export const PIN_ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"] as const);
export const PIN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const PIN_BLOB_SOFT_LIMIT_BYTES = 50 * 1024 * 1024;
export const PIN_EXCALIDRAW_SCENE_MEDIA_TYPE = "application/vnd.tachyon.excalidraw+json";
const FORBIDDEN_SCENE_STRING = /data:image|;base64,|blob:|vscode-webview|\/(?:home|mnt|tmp|Users)\b|[A-Za-z]:\\/i;

export interface PutPinImageInput {
  data: Buffer;
  mediaType: string;
  name?: string;
  source: PinAttachmentSource;
  width?: number;
  height?: number;
  now?: string;
}

export interface PutPinExcalidrawInput {
  sceneJson: string;
  previewData: Buffer;
  name?: string;
  source: PinSketchSource;
  baseImageAttachmentId?: string;
  existing?: PinExcalidrawAttachment;
  now?: string;
}

export interface NormalizedExcalidrawScene {
  json: string;
  elementCount: number;
}

/** Local, content-addressed blob store for rich pin visual artifacts. */
export class PinAttachmentStore {
  private blobSeq = 0;

  constructor(private readonly workspaceRoot: string) {}

  get pinDir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "pins");
  }

  get blobDir(): string {
    return path.join(this.pinDir, "blobs");
  }

  validateImage(mediaType: string, size: number): void {
    const mt = normalizeMediaType(mediaType);
    if (!PIN_ALLOWED_IMAGE_TYPES.has(mt as PinImageAttachment["mediaType"])) throw new Error(`unsupported pin image type '${mediaType}'`);
    if (size > PIN_IMAGE_MAX_BYTES) throw new Error(`pin image exceeds 10 MB limit`);
  }

  putImage(input: PutPinImageInput): PinImageAttachment {
    const mediaType = normalizeImageMediaType(input.mediaType);
    this.validateImage(mediaType, input.data.length);
    const blobRef = this.writeBlob(input.data);
    return {
      id: `att-${crypto.randomBytes(3).toString("hex")}`,
      kind: "image",
      blobRef,
      mediaType,
      name: input.name?.trim() || defaultImageName(mediaType),
      size: input.data.length,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      createdAt: input.now ?? new Date().toISOString(),
      source: input.source,
      visibility: "local",
    };
  }

  putExcalidraw(input: PutPinExcalidrawInput): PinExcalidrawAttachment {
    this.validateImage("image/png", input.previewData.length);
    const normalized = this.normalizeExcalidrawScene(input.sceneJson);
    const sceneData = Buffer.from(normalized.json, "utf8");
    const now = input.now ?? new Date().toISOString();
    const sceneBlobRef = this.writeBlob(sceneData);
    const previewBlobRef = this.writeBlob(input.previewData);
    return {
      id: input.existing?.id ?? `att-${crypto.randomBytes(3).toString("hex")}`,
      kind: "excalidraw",
      name: input.name?.trim() || input.existing?.name || "Sketch",
      sceneBlobRef,
      previewBlobRef,
      sceneMediaType: PIN_EXCALIDRAW_SCENE_MEDIA_TYPE,
      previewMediaType: "image/png",
      sceneSize: sceneData.length,
      previewSize: input.previewData.length,
      elementCount: normalized.elementCount,
      createdAt: input.existing?.createdAt ?? now,
      updatedAt: now,
      source: input.source,
      ...(input.baseImageAttachmentId ? { baseImageAttachmentId: input.baseImageAttachmentId } : {}),
      visibility: "local",
    };
  }

  normalizeExcalidrawScene(sceneJson: string): NormalizedExcalidrawScene {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sceneJson);
    } catch {
      throw new Error("Excalidraw scene is not valid JSON");
    }
    if (!isRecord(parsed)) throw new Error("Excalidraw scene must be an object");
    const scene = deepClone(parsed);
    const elements = Array.isArray(scene.elements) ? scene.elements : [];
    scene.elements = elements;
    scene.source = "tachyon-pin-studio";
    if (!isRecord(scene.appState)) scene.appState = {};
    const files = isRecord(scene.files) ? scene.files : {};
    const normalizedFiles: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(files)) {
      if (!isRecord(value)) continue;
      const file = { ...value };
      const dataURL = typeof file.dataURL === "string" ? file.dataURL : undefined;
      if (dataURL) {
        const decoded = decodeDataImage(dataURL);
        this.validateImage(decoded.mediaType, decoded.data.length);
        file.blobRef = this.writeBlob(decoded.data);
        file.mimeType = decoded.mediaType;
        file.size = decoded.data.length;
        delete file.dataURL;
      }
      normalizedFiles[id] = file;
    }
    scene.files = normalizedFiles;
    const forbiddenPath = findForbiddenScenePayload(scene);
    if (forbiddenPath) {
      throw new Error(`Excalidraw scene contains a forbidden local or inline payload at ${forbiddenPath}`);
    }
    const json = `${JSON.stringify(scene, null, 2)}\n`;
    const elementCount = elements.filter((el: unknown) => !isRecord(el) || el.isDeleted !== true).length;
    return { json, elementCount };
  }

  readExcalidrawScene(att: PinExcalidrawAttachment): string {
    const raw = fs.readFileSync(this.blobPath(att.sceneBlobRef), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Excalidraw scene blob '${att.sceneBlobRef}' is not valid JSON`);
    }
    if (!isRecord(parsed)) throw new Error(`Excalidraw scene blob '${att.sceneBlobRef}' must be an object`);
    const scene = deepClone(parsed);
    const files = isRecord(scene.files) ? scene.files : {};
    for (const value of Object.values(files)) {
      if (!isRecord(value)) continue;
      const blobRef = typeof value.blobRef === "string" ? value.blobRef : undefined;
      const mediaType = typeof value.mimeType === "string" ? normalizeImageMediaType(value.mimeType) : undefined;
      if (!blobRef || !mediaType) continue;
      const data = fs.readFileSync(this.blobPath(blobRef));
      value.dataURL = `data:${mediaType};base64,${data.toString("base64")}`;
      delete value.blobRef;
      delete value.size;
    }
    return JSON.stringify(scene);
  }

  writeBlob(data: Buffer): string {
    const blobRef = crypto.createHash("sha256").update(data).digest("hex");
    const p = this.blobPath(blobRef);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(this.blobDir, { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${this.blobSeq++}`;
      fs.writeFileSync(tmp, data);
      try {
        fs.renameSync(tmp, p);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
        if (!fs.existsSync(p)) throw err;
      }
    }
    return blobRef;
  }

  blobPath(blobRef: string): string {
    if (!isPinBlobRef(blobRef)) throw new Error(`invalid pin blob ref '${blobRef}'`);
    const p = path.resolve(this.blobDir, blobRef);
    const root = path.resolve(this.blobDir);
    if (p !== path.join(root, path.basename(p))) throw new Error(`pin blob ref escapes blob dir`);
    return p;
  }

  relativeBlobPath(blobRef: string): string {
    if (!isPinBlobRef(blobRef)) throw new Error(`invalid pin blob ref '${blobRef}'`);
    return `.tachyon/pins/blobs/${blobRef}`;
  }

  resolveAttachment(att: PinAttachment): ResolvedPinAttachment {
    if (att.kind === "excalidraw") {
      return {
        ...att,
        scenePath: this.safeRelativeBlobPath(att.sceneBlobRef),
        sceneAvailable: this.safeBlobExists(att.sceneBlobRef),
        previewPath: this.safeRelativeBlobPath(att.previewBlobRef),
        previewAvailable: this.safeBlobExists(att.previewBlobRef),
      };
    }
    try {
      const p = this.blobPath(att.blobRef);
      return { ...att, path: this.relativeBlobPath(att.blobRef), available: fs.existsSync(p) };
    } catch {
      return { ...att, path: `.tachyon/pins/blobs/${safeDisplayComponent(att.blobRef)}`, available: false };
    }
  }

  totalBlobBytes(): number {
    let total = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(this.blobDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!isPinBlobRef(entry)) continue;
      try { total += fs.statSync(path.join(this.blobDir, entry)).size; } catch { /* ignore raced delete */ }
    }
    return total;
  }

  overSoftLimit(): boolean {
    return this.totalBlobBytes() > PIN_BLOB_SOFT_LIMIT_BYTES;
  }

  private safeBlobExists(blobRef: string): boolean {
    try { return fs.existsSync(this.blobPath(blobRef)); } catch { return false; }
  }

  private safeRelativeBlobPath(blobRef: string): string {
    try { return this.relativeBlobPath(blobRef); } catch { return `.tachyon/pins/blobs/${safeDisplayComponent(blobRef)}`; }
  }
}

export function isPinBlobRef(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function normalizeMediaType(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeImageMediaType(value: string): PinImageAttachment["mediaType"] {
  const mediaType = normalizeMediaType(value);
  if (!PIN_ALLOWED_IMAGE_TYPES.has(mediaType as PinImageAttachment["mediaType"])) throw new Error(`unsupported pin image type '${value}'`);
  return mediaType as PinImageAttachment["mediaType"];
}

function defaultImageName(mediaType: string): string {
  const ext = mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
  return `image.${ext}`;
}

function safeDisplayComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function findForbiddenScenePayload(value: unknown, trail = "$"): string | undefined {
  if (typeof value === "string") return FORBIDDEN_SCENE_STRING.test(value) ? trail : undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenScenePayload(value[i], `${trail}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const found = findForbiddenScenePayload(child, `${trail}.${key}`);
    if (found) return found;
  }
  return undefined;
}

function decodeDataImage(dataURL: string): { mediaType: PinImageAttachment["mediaType"]; data: Buffer } {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataURL);
  if (!match) throw new Error("Excalidraw image file must be a data:image base64 payload before normalization");
  const mediaType = normalizeImageMediaType(match[1]);
  if (!match[2]) throw new Error("Excalidraw image file is empty");
  return { mediaType, data: Buffer.from(match[2], "base64") };
}
