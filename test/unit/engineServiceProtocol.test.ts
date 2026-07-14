import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  engineBundleId,
  isEngineBundleManifestV1,
  isSafeBundlePath,
  negotiateEngineShellProtocol,
  type EngineBundleFileV1,
  type EngineBundleManifestV1,
} from "../../src/engine-service/protocol.js";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function manifest(
  files: EngineBundleFileV1[] = [{ path: "engine.cjs", sha256: hash("engine"), executable: true }],
): EngineBundleManifestV1 {
  return {
    schemaVersion: 1,
    engineVersion: "0.57.0",
    protocol: { min: 1, max: 2 },
    entrypoint: "engine.cjs",
    files,
    build: { commit: "a".repeat(40), treeSha: "b".repeat(40), workingTreeClean: true },
  };
}

describe("persistent engine protocol", () => {
  it("validates a closed, traversal-free bundle manifest", () => {
    expect(isEngineBundleManifestV1(manifest())).toBe(true);
    for (const unsafe of ["", "/abs", "../escape", "a/../escape", "./engine.cjs", "a\\engine.cjs", "a//b", "C:/escape", "a:b"]) {
      expect(isSafeBundlePath(unsafe), unsafe).toBe(false);
    }
    expect(isEngineBundleManifestV1({ ...manifest(), entrypoint: "../engine.cjs" })).toBe(false);
    expect(isEngineBundleManifestV1({ ...manifest(), files: [...manifest().files, ...manifest().files] })).toBe(false);
    expect(isEngineBundleManifestV1({ ...manifest(), entrypoint: "missing.cjs" })).toBe(false);
  });

  it("negotiates only overlapping protocol ranges and picks the highest shared version", () => {
    expect(negotiateEngineShellProtocol({ min: 1, max: 3 }, { min: 2, max: 4 })).toBe(3);
    expect(negotiateEngineShellProtocol({ min: 1, max: 1 }, { min: 2, max: 2 })).toBeUndefined();
  });

  it("derives one stable bundle id independent of file declaration order", () => {
    const a = { path: "engine.cjs", sha256: hash("engine"), executable: true };
    const b = { path: "assets/helper.js", sha256: hash("helper") };
    expect(engineBundleId(manifest([a, b]))).toBe(engineBundleId(manifest([b, a])));
    expect(engineBundleId(manifest([a]))).not.toBe(engineBundleId(manifest([a, b])));
  });
});
