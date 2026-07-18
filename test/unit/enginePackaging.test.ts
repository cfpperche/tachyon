import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyStagedBundle } from "../../src/engine-service/engineBundleStore.js";
import {
  ENGINE_SHELL_PROTOCOL,
  engineBundleId,
  isEngineBundleManifestV1,
  type EngineBundleManifestV1,
} from "../../src/engine-service/protocol.js";

const engineRoot = path.resolve("dist/engine");
let builtManifest: EngineBundleManifestV1;

beforeAll(async () => {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(engineRoot, "engine-manifest.json"), "utf8"));
      if (!isEngineBundleManifestV1(parsed)) throw new Error("invalid built engine manifest");
      verifyStagedBundle(engineRoot, parsed);
      builtManifest = parsed;
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
});

describe("persistent engine packaging", () => {
  it("builds a self-contained verified engine bundle with its runtime media", () => {
    const root = engineRoot;
    const parsed = builtManifest;
    expect(parsed.channel).toBe("dev");
    expect(parsed.engineVersion).toBe(JSON.parse(fs.readFileSync("package.json", "utf8")).version);
    expect(parsed.protocol).toEqual({ min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL });
    expect(parsed.entrypoint).toBe("engine-daemon.cjs");
    expect(parsed.files.map((file) => file.path)).toEqual([
      "engine-daemon.cjs",
      "pi-bridge-extension.mjs",
      "media/clipboard-copy.sh",
    ]);
    expect(engineBundleId(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyStagedBundle(root, parsed)).not.toThrow();
    expect(fs.readFileSync(path.join(root, "media", "clipboard-copy.sh"))).toEqual(
      fs.readFileSync("media/clipboard-copy.sh"),
    );
    const piExtension = fs.readFileSync(path.join(root, "pi-bridge-extension.mjs"), "utf8");
    expect(piExtension).toContain("TACHYON_AGENT_BRIDGE_TOKEN");
    expect(piExtension).not.toContain(process.env.TACHYON_AGENT_BRIDGE_TOKEN ?? "never-a-real-token");
  });

  it("executes independently and has no VS Code runtime dependency", () => {
    const daemon = path.join(engineRoot, "engine-daemon.cjs");
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
