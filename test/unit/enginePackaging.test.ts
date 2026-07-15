import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyStagedBundle } from "../../src/engine-service/engineBundleStore.js";
import {
  ENGINE_SHELL_PROTOCOL,
  engineBundleId,
  isEngineBundleManifestV1,
} from "../../src/engine-service/protocol.js";

describe("persistent engine packaging", () => {
  it("builds a self-contained verified engine bundle with its runtime media", () => {
    const root = path.resolve("dist/engine");
    const manifestPath = path.join(root, "engine-manifest.json");
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(isEngineBundleManifestV1(parsed)).toBe(true);
    if (!isEngineBundleManifestV1(parsed)) throw new Error("invalid built engine manifest");
    expect(parsed.engineVersion).toBe(JSON.parse(fs.readFileSync("package.json", "utf8")).version);
    expect(parsed.protocol).toEqual({ min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL });
    expect(parsed.entrypoint).toBe("engine-daemon.cjs");
    expect(parsed.files.map((file) => file.path)).toEqual([
      "engine-daemon.cjs",
      "media/clipboard-copy.sh",
    ]);
    expect(engineBundleId(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyStagedBundle(root, parsed)).not.toThrow();
    expect(fs.readFileSync(path.join(root, "media", "clipboard-copy.sh"))).toEqual(
      fs.readFileSync("media/clipboard-copy.sh"),
    );
  });

  it("executes independently and has no VS Code runtime dependency", () => {
    const daemon = path.resolve("dist/engine/engine-daemon.cjs");
    let stderr = "";
    try {
      execFileSync(process.execPath, [daemon], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? "");
    }
    expect(stderr).toContain("missing persistent engine daemon options");
    expect(fs.readFileSync(daemon, "utf8")).not.toMatch(/require\(["']vscode["']\)/);
  });
});
