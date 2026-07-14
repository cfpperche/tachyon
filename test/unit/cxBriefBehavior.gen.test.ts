import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRIEF_FILE_THRESHOLD, SAFE_INLINE_CEILING, briefFilePath, deliverableBody } from "../../src/agents/briefFile.js";

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
      new RegExp(`${Buffer.byteLength(body)} bytes.*safe inline ceiling.*EACCES: permission denied, open spawn brief`),
    );
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

  it("measures transport ceilings in UTF-8 bytes without altering the body", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cx-brief-"));
    const body = "🧭".repeat(BRIEF_FILE_THRESHOLD / 2);
    expect(body.length).toBeLessThanOrEqual(BRIEF_FILE_THRESHOLD);
    expect(Buffer.byteLength(body)).toBeGreaterThan(BRIEF_FILE_THRESHOLD);

    expect(deliverableBody(workspaceRoot, "utf8", body)).toContain(briefFilePath(workspaceRoot, "utf8"));
    expect(fs.readFileSync(briefFilePath(workspaceRoot, "utf8"), "utf8")).toBe(body);
  });
});
