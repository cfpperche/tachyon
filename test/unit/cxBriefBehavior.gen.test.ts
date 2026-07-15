import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRIEF_FILE_THRESHOLD, SAFE_INLINE_CEILING, assertSafeBriefTransport, briefFilePath, deliverableBody } from "../../src/agents/briefFile.js";

describe("container-generated delegation behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an oversized brief with an unwritable briefs dir fails the spawn with a clear error instead of inlining past the tmux ceiling", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cx-brief-"));
    const body = "x".repeat(SAFE_INLINE_CEILING + 1);
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied, open spawn brief");
    });

    expect(() => deliverableBody(workspaceRoot, "oversized", body)).toThrow(
      new RegExp(`${body.length} UTF-8 bytes.*shell-escaped transport bytes.*safe inline ceiling.*EACCES: permission denied, open spawn brief`),
    );
  });

  it("measures the inline safety ceiling in UTF-8 bytes rather than JavaScript characters", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cx-brief-"));
    const body = "é".repeat(SAFE_INLINE_CEILING / 2 + 1);
    expect(body.length).toBeLessThan(SAFE_INLINE_CEILING);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(SAFE_INLINE_CEILING);
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    expect(() => deliverableBody(workspaceRoot, "utf8-oversized", body)).toThrow(/UTF-8 bytes.*safe inline ceiling/);
  });

  it("a write failure at or below the safe inline ceiling preserves the inline fallback", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cx-brief-"));
    const body = "x".repeat(SAFE_INLINE_CEILING);
    expect(body.length).toBeGreaterThan(BRIEF_FILE_THRESHOLD);
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    expect(deliverableBody(workspaceRoot, "inline-fallback", body)).toBe(body);
  });

  it("normal long spawn briefs are written under the spawn namespace", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cx-brief-"));
    const body = "x".repeat(BRIEF_FILE_THRESHOLD + 1);
    const file = briefFilePath(workspaceRoot, "writer");

    const pointer = deliverableBody(workspaceRoot, "writer", body);

    expect(file).toBe(path.join(workspaceRoot, ".tachyon", "briefs", "spawn", "writer.md"));
    expect(pointer).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });

  it("diverts a multibyte body when its UTF-8 bytes cross the file threshold", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cx-brief-"));
    const body = "é".repeat(BRIEF_FILE_THRESHOLD / 2 + 1);
    expect(body.length).toBeLessThan(BRIEF_FILE_THRESHOLD);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(BRIEF_FILE_THRESHOLD);

    const pointer = deliverableBody(workspaceRoot, "utf8-writer", body);

    expect(pointer).toContain("UTF-8 bytes");
    expect(fs.readFileSync(briefFilePath(workspaceRoot, "utf8-writer"), "utf8")).toBe(body);
  });

  it("diverts apostrophe-heavy content before shell quoting can exceed tmux's argv ceiling", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cx-brief-"));
    const body = "'".repeat(BRIEF_FILE_THRESHOLD - 100);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(BRIEF_FILE_THRESHOLD);

    const pointer = deliverableBody(workspaceRoot, "quoted-writer", body);

    expect(pointer).not.toBe(body);
    expect(fs.readFileSync(briefFilePath(workspaceRoot, "quoted-writer"), "utf8")).toBe(body);
  });

  it("rejects oversized dynamic framing after body diversion and before tmux delivery", () => {
    const verifyHeavyPrimer = `primer:${"'".repeat(SAFE_INLINE_CEILING / 3)}`;
    expect(Buffer.byteLength(verifyHeavyPrimer, "utf8")).toBeLessThan(SAFE_INLINE_CEILING);
    expect(() => assertSafeBriefTransport(verifyHeavyPrimer, "worker startup brief")).toThrow(
      /worker startup brief.*shell-escaped transport bytes.*safe pane-delivery ceiling/,
    );
  });
});
