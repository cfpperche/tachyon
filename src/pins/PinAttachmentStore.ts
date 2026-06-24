import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PinAttachment, PinAttachmentSource, ResolvedPinAttachment } from "./types.js";

export type { PinAttachment, PinAttachmentSource, ResolvedPinAttachment } from "./types.js";

export const PIN_ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const PIN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const PIN_BLOB_SOFT_LIMIT_BYTES = 50 * 1024 * 1024;

export interface PutPinImageInput {
  data: Buffer;
  mediaType: string;
  name?: string;
  source: PinAttachmentSource;
  width?: number;
  height?: number;
  now?: string;
}

/** Local, content-addressed blob store for rich pin image attachments. */
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
    if (!PIN_ALLOWED_IMAGE_TYPES.has(mt)) throw new Error(`unsupported pin image type '${mediaType}'`);
    if (size > PIN_IMAGE_MAX_BYTES) throw new Error(`pin image exceeds 10 MB limit`);
  }

  putImage(input: PutPinImageInput): PinAttachment {
    const mediaType = normalizeMediaType(input.mediaType);
    this.validateImage(mediaType, input.data.length);
    const blobRef = crypto.createHash("sha256").update(input.data).digest("hex");
    const p = this.blobPath(blobRef);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(this.blobDir, { recursive: true });
      const tmp = `${p}.tmp.${process.pid}.${this.blobSeq++}`;
      fs.writeFileSync(tmp, input.data);
      try {
        fs.renameSync(tmp, p);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
        if (!fs.existsSync(p)) throw err;
      }
    }
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
}

export function isPinBlobRef(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function normalizeMediaType(value: string): string {
  return value.trim().toLowerCase();
}

function defaultImageName(mediaType: string): string {
  const ext = mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
  return `image.${ext}`;
}

function safeDisplayComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "invalid";
}
