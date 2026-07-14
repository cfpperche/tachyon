import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIEF_FILE_THRESHOLD, briefFilePath, deliverableBody } from "../../src/agents/briefFile.js";

describe("purpose-specific brief files", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps a long re-anchor from overwriting the spawn contract", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-brief-purpose-"));
    roots.push(root);
    const spawnBody = `spawn:${"s".repeat(BRIEF_FILE_THRESHOLD)}`;
    const reanchorBody = `reanchor:${"r".repeat(BRIEF_FILE_THRESHOLD)}`;

    deliverableBody(root, "worker", spawnBody);
    const pointer = deliverableBody(root, "worker", reanchorBody, "reanchor");

    expect(fs.readFileSync(briefFilePath(root, "worker"), "utf8")).toBe(spawnBody);
    expect(fs.readFileSync(briefFilePath(root, "worker", "reanchor"), "utf8")).toBe(reanchorBody);
    expect(pointer).toContain("re-anchor context");
    expect(pointer).toContain(briefFilePath(root, "worker", "reanchor"));
  });

  it("atomically preserves an existing brief and removes its temporary file when rename fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-brief-atomic-"));
    roots.push(root);
    const original = `original:${"o".repeat(BRIEF_FILE_THRESHOLD)}`;
    const replacement = `replacement:${"r".repeat(BRIEF_FILE_THRESHOLD)}`;
    const destination = briefFilePath(root, "worker");
    deliverableBody(root, "worker", original);
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EIO: rename failed");
    });

    expect(deliverableBody(root, "worker", replacement)).toBe(replacement);
    expect(fs.readFileSync(destination, "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(destination)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
