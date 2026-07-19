import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIEF_FILE_THRESHOLD, briefFilePath, deliverableBody } from "../../src/agents/briefFile.js";
import type { StartupBriefManifest } from "../../src/agents/startupBrief.js";

const guidanceOnly: StartupBriefManifest = {
  projectGuidanceSources: 2,
  prompt: {
    soul: false,
    role: false,
    persistentInstructions: false,
    bridgeGuidance: false,
    task: { kind: "absent" },
  },
};

describe("purpose-specific brief files", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps a long re-anchor from overwriting the startup brief", () => {
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

  it("writes a bounded inventory before the unchanged startup body", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-brief-inventory-"));
    roots.push(root);
    const body = `GUIDANCE:${"g".repeat(BRIEF_FILE_THRESHOLD)}`;

    const pointer = deliverableBody(root, "worker", body, "spawn", guidanceOnly);
    const stored = fs.readFileSync(briefFilePath(root, "worker"), "utf8");

    expect(pointer).toContain("Your full startup brief is long");
    expect(pointer).toContain("project guidance (2 sources)");
    expect(pointer).toContain("Task objective: absent");
    expect(pointer).toContain("before-finishing reminder");
    expect(stored).toContain("── STARTUP BRIEF CONTENTS ──");
    expect(stored.endsWith(body)).toBe(true);
  });

  it("retains an old long file as unreferenced residue after a later inline delivery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-brief-residue-"));
    roots.push(root);
    const longBody = `LONG:${"l".repeat(BRIEF_FILE_THRESHOLD)}`;
    const shortBody = "short current launch";
    const file = briefFilePath(root, "worker");
    deliverableBody(root, "worker", longBody, "spawn", guidanceOnly);

    const current = deliverableBody(root, "worker", shortBody, "spawn", guidanceOnly);

    expect(current).toBe(shortBody);
    expect(current).not.toContain(file);
    expect(fs.readFileSync(file, "utf8")).toContain(longBody);
  });
});
