/**
 * Persist first-person Companion screenshots to the workspace.
 *
 * Transport from the extension still uses a data URL over the local companion
 * channel; the model-facing tool result must NOT carry that payload (large
 * base64 is truncated / dropped on the multimodal path). Bytes land under
 * `.tachyon/companion/screenshots/` (gitignored with the rest of `.tachyon/`)
 * and tools return a short workspace-relative path for `read_file` / vision.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Workspace-relative dir (posix) for companion first-person captures. */
export const COMPANION_SCREENSHOT_REL_DIR = ".tachyon/companion/screenshots";

/** Hard cap so a bad capture cannot fill the disk. */
export const COMPANION_SCREENSHOT_MAX_BYTES = 12 * 1024 * 1024;

export type PersistScreenshotOk = {
  ok: true;
  /** Workspace-relative posix path (e.g. `.tachyon/companion/screenshots/….jpg`). */
  path: string;
  byteLength: number;
  mimeType: "image/jpeg" | "image/png";
  format: "jpeg" | "png";
};

export type PersistScreenshotErr = { ok: false; reason: string };

export type PersistScreenshotResult = PersistScreenshotOk | PersistScreenshotErr;

export function parseScreenshotDataUrl(
  dataUrl: string,
): { mimeType: "image/jpeg" | "image/png"; buffer: Buffer } | { error: string } {
  if (typeof dataUrl !== "string" || dataUrl.length < 32) {
    return { error: "Screenshot payload missing or too short." };
  }
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!m) return { error: "Screenshot payload is not a data:image;base64 URL." };
  const rawMime = m[1]!.trim().toLowerCase();
  if (rawMime !== "image/jpeg" && rawMime !== "image/png") {
    return { error: `Unsupported screenshot mime type: ${rawMime}` };
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(m[2]!, "base64");
  } catch {
    return { error: "Failed to decode screenshot base64." };
  }
  if (buffer.length === 0) return { error: "Screenshot decoded to empty buffer." };
  if (buffer.length > COMPANION_SCREENSHOT_MAX_BYTES) {
    return {
      error: `Screenshot too large (${buffer.length} bytes; max ${COMPANION_SCREENSHOT_MAX_BYTES}).`,
    };
  }
  return { mimeType: rawMime, buffer };
}

function safeFileId(id: string | undefined): string {
  const cleaned = (id ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16);
  return cleaned || randomBytes(4).toString("hex");
}

function stampFromIso(iso: string | undefined): string {
  const raw = (iso ?? new Date().toISOString()).replace(/[:.]/g, "-");
  // Keep filesystem-safe; cap length.
  return raw.replace(/[^0-9A-Za-zT_-]/g, "").slice(0, 40) || "shot";
}

/**
 * Decode a companion screenshot data URL and write it under the workspace.
 * Never trusts caller-supplied paths — only generates names under the fixed dir.
 */
export function persistCompanionScreenshot(opts: {
  workspaceRoot: string;
  dataUrl: string;
  /** Optional command id for stable-ish filenames. */
  id?: string;
  capturedAt?: string;
}): PersistScreenshotResult {
  const root = path.resolve(opts.workspaceRoot);
  if (!root) return { ok: false, reason: "workspaceRoot is required." };

  const parsed = parseScreenshotDataUrl(opts.dataUrl);
  if ("error" in parsed) return { ok: false, reason: parsed.error };

  const format = parsed.mimeType === "image/png" ? "png" : "jpeg";
  const ext = format === "png" ? "png" : "jpg";
  const name = `${stampFromIso(opts.capturedAt)}-${safeFileId(opts.id)}.${ext}`;
  const absDir = path.join(root, ".tachyon", "companion", "screenshots");
  const absFile = path.join(absDir, name);

  // Refuse to write outside the workspace root (defense in depth).
  const resolvedFile = path.resolve(absFile);
  if (resolvedFile !== root && !resolvedFile.startsWith(root + path.sep)) {
    return { ok: false, reason: "Refusing to write screenshot outside workspace." };
  }

  try {
    fs.mkdirSync(absDir, { recursive: true });
    fs.writeFileSync(absFile, parsed.buffer);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  return {
    ok: true,
    path: path.posix.join(COMPANION_SCREENSHOT_REL_DIR, name),
    byteLength: parsed.buffer.length,
    mimeType: parsed.mimeType,
    format,
  };
}

/**
 * Strip transport-only `dataUrl` from a screenshot tab result and attach `path`
 * when persistence succeeded. Used by the agent-facing tool surface.
 */
export function modelFacingScreenshotResult(
  result: unknown,
  workspaceRoot: string,
):
  | { kind: "persisted"; payload: Record<string, unknown> }
  | { kind: "persist_failed"; reason: string }
  | { kind: "passthrough"; payload: unknown } {
  if (!result || typeof result !== "object") {
    return { kind: "passthrough", payload: result };
  }
  const r = result as Record<string, unknown>;
  if (r.ok !== true || r.kind !== "screenshot" || typeof r.dataUrl !== "string") {
    return { kind: "passthrough", payload: result };
  }

  const saved = persistCompanionScreenshot({
    workspaceRoot,
    dataUrl: r.dataUrl,
    id: typeof r.id === "string" ? r.id : undefined,
    capturedAt: typeof r.capturedAt === "string" ? r.capturedAt : undefined,
  });
  if (!saved.ok) return { kind: "persist_failed", reason: saved.reason };

  // Never include dataUrl in the model-facing payload.
  const { dataUrl: _drop, ...rest } = r;
  return {
    kind: "persisted",
    payload: {
      ...rest,
      path: saved.path,
      byteLength: saved.byteLength,
      mimeType: saved.mimeType,
      format: saved.format,
    },
  };
}
