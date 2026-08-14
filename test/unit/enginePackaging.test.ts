import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { verifyStagedBundle } from "@tachyon/engine/engine-service/engineBundleStore.js";
import {
  ENGINE_SHELL_PROTOCOL,
  engineBundleId,
  isEngineBundleManifestV1,
  type EngineBundleManifestV1,
} from "@tachyon/engine/engine-service/protocol.js";

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
    // Core daemon + clipboard helper + companion-mobile PWA (SDD 422; full tree so app.js is not 404).
    // t-05a0b0: sourcemaps are NEVER staged — the ship boundary prunes .map from the VSIX, so a
    // staged map would leave the installed manifest promising a file the package lacks.
    const companionMobile = fs
      .readdirSync("media/companion-mobile")
      .filter((name) => !name.startsWith("."))
      .filter((name) => !name.endsWith(".map"))
      .filter((name) => fs.statSync(path.join("media/companion-mobile", name)).isFile())
      .sort()
      .map((name) => `media/companion-mobile/${name}`);
    expect(parsed.files.map((file) => file.path)).toEqual([
      "engine-daemon.cjs",
      "pi-bridge-extension.mjs",
      "media/clipboard-copy.sh",
      ...companionMobile,
    ]);
    expect(engineBundleId(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyStagedBundle(root, parsed)).not.toThrow();
    expect(fs.readFileSync(path.join(root, "media", "clipboard-copy.sh"))).toEqual(
      fs.readFileSync("media/clipboard-copy.sh"),
    );
    expect(fs.readFileSync(path.join(root, "media", "companion-mobile", "index.html"))).toEqual(
      fs.readFileSync("media/companion-mobile/index.html"),
    );
    expect(fs.existsSync(path.join(root, "media", "companion-mobile", "app.js"))).toBe(true);
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

  it("t-05a0b0: every manifest entry survives the ship boundary — a promised file must never be pruned from the VSIX", async () => {
    // 0.56.102 shipped a manifest referencing companion-mobile app.js.map, which prepare-package
    // pruned (.map is a dev artifact); the installed activation then failed closed on ENOENT.
    // This ties the built manifest to the boundary INSIDE the suite, so verify:full catches the
    // inconsistency long before packaging does.
    const { classifyShipFile } = await import("../../scripts/ship-boundary.mjs");
    const pruned = builtManifest.files
      .map((file) => `dist/engine/${file.path}`)
      .filter((rel) => classifyShipFile(rel) !== "allowed");
    expect(pruned).toEqual([]);
  });

  it("t-05a0b0: engineManifestClosureViolations reports missing and altered manifest entries", async () => {
    const { engineManifestClosureViolations } = await import("../../scripts/ship-boundary.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-closure-"));
    try {
      fs.mkdirSync(path.join(dir, "media"), { recursive: true });
      fs.writeFileSync(path.join(dir, "engine-daemon.cjs"), "ok");
      const sha = (body: string) => createHash("sha256").update(body).digest("hex");
      const manifest = {
        files: [
          { path: "engine-daemon.cjs", sha256: sha("ok") },
          { path: "media/app.js.map", sha256: sha("gone") },
        ],
      };
      expect(engineManifestClosureViolations(dir, manifest)).toEqual([
        "media/app.js.map: missing from the pack tree (pruned or never staged)",
      ]);

      fs.writeFileSync(path.join(dir, "media", "app.js.map"), "tampered");
      expect(engineManifestClosureViolations(dir, manifest)).toEqual([
        "media/app.js.map: sha256 mismatch vs manifest",
      ]);

      fs.writeFileSync(path.join(dir, "media", "app.js.map"), "gone");
      expect(engineManifestClosureViolations(dir, manifest)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
