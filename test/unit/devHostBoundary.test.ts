import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_HOST_MARKER,
  assertMarkedDevHostWorkspace,
  engineShellReleasePolicy,
} from "../../src/engine-service/devHostBoundary.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-dev-host-boundary-"));
  roots.push(root);
  return root;
}

describe("Dev Host engine boundary", () => {
  it("selects stable only for installed production and marks only development", () => {
    expect(engineShellReleasePolicy("production")).toEqual({
      requiredChannel: "stable",
      requireCleanBuild: true,
      requireMarkedDevHost: false,
    });
    expect(engineShellReleasePolicy("development")).toEqual({
      requiredChannel: "dev",
      requireCleanBuild: false,
      requireMarkedDevHost: true,
    });
    expect(engineShellReleasePolicy("test")).toEqual({
      requiredChannel: "dev",
      requireCleanBuild: false,
      requireMarkedDevHost: false,
    });
  });

  it("accepts only the closed regular marker shape", () => {
    const root = workspace();
    fs.writeFileSync(
      path.join(root, DEV_HOST_MARKER),
      `${JSON.stringify({ schemaVersion: 1, kind: "tachyon-dev-host" })}\n`,
      { mode: 0o600 },
    );
    expect(() => assertMarkedDevHostWorkspace(root)).not.toThrow();
  });

  it("refuses an ordinary unmarked workspace with an actionable error", () => {
    const root = workspace();
    expect(() => assertMarkedDevHostWorkspace(root))
      .toThrowError(expect.objectContaining({ code: "DEV_HOST_MARKER_MISSING" }));
    expect(() => assertMarkedDevHostWorkspace(root)).toThrow(/dogfood -- dev-host -- point/);
  });

  it("refuses malformed, open-ended, or symlinked markers", () => {
    const root = workspace();
    const marker = path.join(root, DEV_HOST_MARKER);
    fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, kind: "tachyon-dev-host", channel: "stable" }));
    expect(() => assertMarkedDevHostWorkspace(root))
      .toThrowError(expect.objectContaining({ code: "DEV_HOST_MARKER_INVALID" }));

    fs.rmSync(marker);
    const external = path.join(workspace(), "marker.json");
    fs.writeFileSync(external, JSON.stringify({ schemaVersion: 1, kind: "tachyon-dev-host" }));
    fs.symlinkSync(external, marker);
    expect(() => assertMarkedDevHostWorkspace(root))
      .toThrowError(expect.objectContaining({ code: "DEV_HOST_MARKER_INVALID" }));
  });
});
