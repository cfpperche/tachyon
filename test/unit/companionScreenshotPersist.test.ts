import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMPANION_SCREENSHOT_REL_DIR,
  modelFacingScreenshotResult,
  parseScreenshotDataUrl,
  persistCompanionScreenshot,
} from "../../src/companion/screenshotPersist.js";

/** Minimal valid 1x1 JPEG (raw base64). */
const JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z";

function jpegDataUrl(): string {
  return `data:image/jpeg;base64,${JPEG_B64}`;
}

describe("parseScreenshotDataUrl", () => {
  it("decodes jpeg data URL", () => {
    const r = parseScreenshotDataUrl(jpegDataUrl());
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.mimeType).toBe("image/jpeg");
    expect(r.buffer.length).toBeGreaterThan(10);
  });

  it("rejects non-image mime", () => {
    const r = parseScreenshotDataUrl("data:text/plain;base64,aGVsbG8=");
    expect("error" in r).toBe(true);
  });

  it("rejects empty / garbage", () => {
    expect("error" in parseScreenshotDataUrl("")).toBe(true);
    expect("error" in parseScreenshotDataUrl("not-a-data-url")).toBe(true);
  });
});

describe("persistCompanionScreenshot", () => {
  it("writes under .tachyon/companion/screenshots and returns workspace-relative path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-shot-"));
    try {
      const saved = persistCompanionScreenshot({
        workspaceRoot: root,
        dataUrl: jpegDataUrl(),
        id: "abc123",
        capturedAt: "2026-07-20T12:00:00.000Z",
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.path.startsWith(COMPANION_SCREENSHOT_REL_DIR + "/")).toBe(true);
      expect(saved.path.endsWith(".jpg")).toBe(true);
      expect(saved.format).toBe("jpeg");
      expect(saved.mimeType).toBe("image/jpeg");
      const abs = path.join(root, ...saved.path.split("/"));
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.statSync(abs).size).toBe(saved.byteLength);
      expect(saved.byteLength).toBeGreaterThan(10);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("modelFacingScreenshotResult", () => {
  it("strips dataUrl and attaches path on success", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-shot-"));
    try {
      const transport = {
        ok: true as const,
        id: "deadbeef",
        kind: "screenshot" as const,
        url: "https://example.com",
        title: "Example",
        capturedAt: "2026-07-20T12:00:00.000Z",
        dataUrl: jpegDataUrl(),
        byteLength: 999,
        mimeType: "image/jpeg",
      };
      const facing = modelFacingScreenshotResult(transport, root);
      expect(facing.kind).toBe("persisted");
      if (facing.kind !== "persisted") return;
      expect(facing.payload.dataUrl).toBeUndefined();
      expect(typeof facing.payload.path).toBe("string");
      expect(String(facing.payload.path)).toContain(COMPANION_SCREENSHOT_REL_DIR);
      expect(facing.payload.url).toBe("https://example.com");
      expect(facing.payload.title).toBe("Example");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passthrough on errors / non-screenshot results", () => {
    const err = { ok: false, id: "x", code: "timeout", message: "nope" };
    expect(modelFacingScreenshotResult(err, "/tmp").kind).toBe("passthrough");
    const snap = { ok: true, kind: "snapshot", outline: "…" };
    expect(modelFacingScreenshotResult(snap, "/tmp").kind).toBe("passthrough");
  });
});
