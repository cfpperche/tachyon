import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  EngineBundleError,
  engineBundleInstallRoot,
  stageEngineBundle,
} from "../../src/engine-service/engineBundleStore.js";
import type { EngineBundleManifestV1 } from "../../src/engine-service/protocol.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fixture(): { source: string; manifest: EngineBundleManifestV1 } {
  const source = temp("tachyon-engine-source-");
  fs.mkdirSync(path.join(source, "assets"));
  fs.writeFileSync(path.join(source, "engine.cjs"), "engine");
  fs.writeFileSync(path.join(source, "assets", "helper.js"), "helper");
  return {
    source,
    manifest: {
      schemaVersion: 1,
      engineVersion: "0.57.0",
      protocol: { min: 1, max: 1 },
      entrypoint: "engine.cjs",
      files: [
        { path: "engine.cjs", sha256: sha256("engine"), executable: true },
        { path: "assets/helper.js", sha256: sha256("helper") },
      ],
      build: { commit: "a".repeat(40), treeSha: "b".repeat(40), workingTreeClean: true },
    },
  };
}

describe("engine bundle store", () => {
  it("atomically stages outside the extension source and reuses the verified immutable id", () => {
    const { source, manifest } = fixture();
    const installRoot = path.join(temp("tachyon-engine-install-parent-"), "private", "bundles");
    const first = stageEngineBundle({ sourceRoot: source, manifest, installRoot });
    expect(first.reused).toBe(false);
    expect(first.root.startsWith(path.resolve(installRoot) + path.sep)).toBe(true);
    expect(first.root.startsWith(path.resolve(source) + path.sep)).toBe(false);
    expect(fs.readFileSync(first.entrypoint, "utf8")).toBe("engine");
    expect(fs.statSync(first.entrypoint).mode & 0o777).toBe(0o500);

    const second = stageEngineBundle({ sourceRoot: source, manifest, installRoot });
    expect(second).toMatchObject({ bundleId: first.bundleId, root: first.root, reused: true });
    expect(fs.readdirSync(installRoot).filter((name) => name.startsWith(".") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a dirty build and source hash drift without leaving a staged target", () => {
    const { source, manifest } = fixture();
    const installRoot = path.join(temp("tachyon-engine-refuse-parent-"), "private", "bundles");
    expect(() => stageEngineBundle({ sourceRoot: source, manifest: { ...manifest, build: { ...manifest.build, workingTreeClean: false } }, installRoot }))
      .toThrowError(expect.objectContaining({ code: "DIRTY_BUILD" }));
    fs.writeFileSync(path.join(source, "engine.cjs"), "tampered");
    expect(() => stageEngineBundle({ sourceRoot: source, manifest, installRoot }))
      .toThrowError(expect.objectContaining({ code: "SOURCE_HASH_MISMATCH" }));
    expect(fs.readdirSync(installRoot)).toEqual([]);
  });

  it("never overwrites a corrupt existing immutable bundle id", () => {
    const { source, manifest } = fixture();
    const installRoot = path.join(temp("tachyon-engine-corrupt-parent-"), "private", "bundles");
    const staged = stageEngineBundle({ sourceRoot: source, manifest, installRoot });
    fs.chmodSync(staged.entrypoint, 0o600);
    fs.writeFileSync(staged.entrypoint, "corrupt");
    let caught: unknown;
    try {
      stageEngineBundle({ sourceRoot: source, manifest, installRoot });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineBundleError);
    expect(caught).toMatchObject({ code: "STAGED_HASH_MISMATCH" });
    expect(fs.readFileSync(staged.entrypoint, "utf8")).toBe("corrupt");
  });

  it("resolves a zero-configuration per-user install root on each platform family", () => {
    expect(engineBundleInstallRoot("linux", { XDG_DATA_HOME: "/data" }, "/home/u")).toBe("/data/tachyon/engine-bundles");
    expect(engineBundleInstallRoot("darwin", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/Tachyon/engine-bundles");
    expect(engineBundleInstallRoot("win32", { LOCALAPPDATA: "C:\\Local" }, "C:\\Users\\u"))
      .toBe(path.join("C:\\Local", "Tachyon", "engine-bundles"));
  });
});
