import { describe, it, expect } from "vitest";
import { gatherDataPlan, DATA_ANY_PLATFORM } from "../../src/plugins/dataPlan.js";
import type { LoadedPlugin } from "../../src/plugins/engine.js";
import type { PluginManifest, DataDecl } from "../../src/plugins/manifest.js";
import type { PlatformResolution } from "../../src/plugins/toolPlatform.js";

function pluginWithData(data: Record<string, DataDecl>): LoadedPlugin {
  const manifest = { name: "tr", version: "1.0.0", description: "d", runtimes: [], dependencies: [], blocks: {}, gitHooks: {}, tools: {}, data } as PluginManifest;
  return { dir: "/x", manifest, blocks: {}, rootRel: {}, skills: [], mcp: [], gitHooks: [] };
}

const linux: PlatformResolution = { ok: true, keys: ["linux-x64-glibc", "linux-x64-musl"] } as PlatformResolution;
const SHA = "a".repeat(64);

describe("gatherDataPlan (spec 284)", () => {
  it("plans a single cross-platform blob without a host probe", async () => {
    const plan = await gatherDataPlan(pluginWithData({ model: { version: "base", single: { url: "https://h/m.bin", sha256: SHA } } }));
    expect(plan.unsupported).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ name: "model", resolvedPlatform: DATA_ANY_PLATFORM, sha256: SHA, fileName: "model", finalUrl: "https://h/m.bin" });
  });

  it("honors a declared fileName", async () => {
    const plan = await gatherDataPlan(pluginWithData({ model: { version: "base", fileName: "ggml-base.bin", single: { url: "https://h/m.bin", sha256: SHA } } }));
    expect(plan.items[0].fileName).toBe("ggml-base.bin");
  });

  it("selects the host platform pin for a per-platform artifact", async () => {
    const plan = await gatherDataPlan(
      pluginWithData({ model: { version: "base", platforms: { "linux-x64-glibc": { url: "https://h/lx.bin", sha256: SHA } } } }),
      { platform: linux },
    );
    expect(plan.items[0]).toMatchObject({ resolvedPlatform: "linux-x64-glibc", declaredUrl: "https://h/lx.bin" });
  });

  it("surfaces unsupported when no platform pin matches the host", async () => {
    const plan = await gatherDataPlan(
      pluginWithData({ model: { version: "base", platforms: { "darwin-arm64": { url: "https://h/mac.bin", sha256: SHA } } } }),
      { platform: linux },
    );
    expect(plan.items).toEqual([]);
    expect(plan.unsupported[0].name).toBe("model");
  });

  it("resolves the final URL via the injected resolver (TOCTOU plan)", async () => {
    const plan = await gatherDataPlan(
      pluginWithData({ model: { version: "base", single: { url: "https://h/redir", sha256: SHA } } }),
      { resolveFinalUrl: async () => "https://cdn/final.bin" },
    );
    expect(plan.items[0]).toMatchObject({ declaredUrl: "https://h/redir", finalUrl: "https://cdn/final.bin" });
  });

  it("empty plan when no data declared", async () => {
    const plan = await gatherDataPlan(pluginWithData({}));
    expect(plan).toEqual({ items: [], unsupported: [] });
  });
});
