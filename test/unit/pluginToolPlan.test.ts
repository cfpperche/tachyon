import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatherToolPlan, type ToolPlan } from "../../src/plugins/toolPlan.js";
import { loadPlugin, previewInstall, type LoadedPlugin } from "../../src/plugins/engine.js";
import type { PluginManifest, ToolDecl } from "../../src/plugins/manifest.js";
import type { PlatformResolution } from "../../src/plugins/toolPlatform.js";

const SHA = "a".repeat(64);
const SHB = "b".repeat(64);

function pluginWithTools(tools: Record<string, ToolDecl>): LoadedPlugin {
  const manifest = { name: "cg", version: "1.0.0", description: "d", runtimes: [], dependencies: [], blocks: {}, gitHooks: {}, tools, data: {}, externalTools: {} } as PluginManifest;
  return { dir: "/x", manifest, blocks: {}, rootRel: {}, skills: [], mcp: [], gitHooks: [] };
}

const linux: PlatformResolution = { ok: true, keys: ["linux-x64-glibc"], notes: [] };
const mac: PlatformResolution = { ok: true, keys: ["darwin-arm64", "darwin-x64"], notes: [] };
const unsupported: PlatformResolution = { ok: false, code: "UNSUPPORTED_OS", detail: "Windows" };

describe("gatherToolPlan", () => {
  it("returns an empty plan for a plugin with no tools", async () => {
    const plan = await gatherToolPlan(pluginWithTools({}), { platform: linux });
    expect(plan).toEqual({ items: [], unsupported: [] });
  });

  it("plans a raw-binary tool: exeName = tool name, binSha256 = artifact sha", async () => {
    const decl: ToolDecl = { version: "8.18.4", platforms: { "linux-x64-glibc": { url: "https://x.io/g", sha256: SHA } } };
    const plan = await gatherToolPlan(pluginWithTools({ gitleaks: decl }), { platform: linux });
    expect(plan.items).toEqual([{ name: "gitleaks", version: "8.18.4", resolvedPlatform: "linux-x64-glibc", declaredUrl: "https://x.io/g", finalUrl: "https://x.io/g", sha256: SHA, binSha256: SHA, exeName: "gitleaks" }]);
  });

  it("plans an archive tool: exeName = innerPath basename, binSha256 = archive binSha256", async () => {
    const decl: ToolDecl = { version: "1.0", platforms: { "linux-x64-glibc": { url: "https://x.io/g.tgz", sha256: SHA, archive: { type: "tgz", innerPath: "dist/gitleaks", binSha256: SHB } } } };
    const plan = await gatherToolPlan(pluginWithTools({ gitleaks: decl }), { platform: linux });
    expect(plan.items[0]).toMatchObject({ exeName: "gitleaks", binSha256: SHB, sha256: SHA, archive: { type: "tgz", innerPath: "dist/gitleaks" } });
  });

  it("spec 269 — carries the tool's launchPolicy into the plan item", async () => {
    const lp = { env: { AGENT_BROWSER_CONFIRM_ACTIONS: "click" }, denyArgs: ["--confirm-actions"], mode: "force" as const };
    const decl: ToolDecl = { version: "1.0", platforms: { "linux-x64-glibc": { url: "https://x.io/g", sha256: SHA } }, launchPolicy: lp };
    const plan = await gatherToolPlan(pluginWithTools({ ab: decl }), { platform: linux });
    expect(plan.items[0].launchPolicy).toEqual(lp);
  });

  it("picks the FIRST preference-ordered platform key the tool pins (Rosetta native arm64)", async () => {
    const decl: ToolDecl = { version: "1.0", platforms: { "darwin-x64": { url: "https://x.io/x64", sha256: SHA }, "darwin-arm64": { url: "https://x.io/arm", sha256: SHB } } };
    const plan = await gatherToolPlan(pluginWithTools({ t: decl }), { platform: mac });
    expect(plan.items[0].resolvedPlatform).toBe("darwin-arm64"); // preferred
    expect(plan.items[0].declaredUrl).toBe("https://x.io/arm");
  });

  it("falls back to darwin-x64 when only that is pinned (Rosetta)", async () => {
    const decl: ToolDecl = { version: "1.0", platforms: { "darwin-x64": { url: "https://x.io/x64", sha256: SHA } } };
    const plan = await gatherToolPlan(pluginWithTools({ t: decl }), { platform: mac });
    expect(plan.items[0].resolvedPlatform).toBe("darwin-x64");
  });

  it("surfaces an unsupported host (no silent drop)", async () => {
    const decl: ToolDecl = { version: "1.0", platforms: { "linux-x64-glibc": { url: "https://x.io/g", sha256: SHA } } };
    const plan = await gatherToolPlan(pluginWithTools({ gitleaks: decl }), { platform: unsupported });
    expect(plan.items).toEqual([]);
    expect(plan.unsupported[0]).toMatchObject({ name: "gitleaks" });
  });

  it("surfaces a tool with no pin for the host platform", async () => {
    const decl: ToolDecl = { version: "1.0", platforms: { "darwin-arm64": { url: "https://x.io/g", sha256: SHA } } };
    const plan = await gatherToolPlan(pluginWithTools({ gitleaks: decl }), { platform: linux });
    expect(plan.items).toEqual([]);
    expect(plan.unsupported[0].reason).toMatch(/no pinned artifact/);
  });

  it("uses the injected redirect resolver for finalUrl", async () => {
    const decl: ToolDecl = { version: "1.0", platforms: { "linux-x64-glibc": { url: "https://x.io/g", sha256: SHA } } };
    const plan = await gatherToolPlan(pluginWithTools({ g: decl }), { platform: linux, resolveFinalUrl: async (u) => `${u}?redirected` });
    expect(plan.items[0].finalUrl).toBe("https://x.io/g?redirected");
    expect(plan.items[0].declaredUrl).toBe("https://x.io/g");
  });
});

describe("previewInstall — toolTargets + fingerprint binding (spec 265 task 9)", () => {
  /** A real plugin dir declaring a claude block + a tool, and a workspace. */
  function fixture(): { pluginDir: string; ws: string } {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-tp-plug-"));
    fs.writeFileSync(
      path.join(pluginDir, "tachyon-plugin.json"),
      JSON.stringify({
        name: "cg", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" },
        tools: { gitleaks: { version: "8.18.4", platforms: { "linux-x64-glibc": { url: "https://x.io/g", sha256: SHA } } } },
      }),
    );
    fs.mkdirSync(path.join(pluginDir, "claude"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "claude", "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./gate.sh" }] }] }));
    fs.writeFileSync(path.join(pluginDir, "claude", "gate.sh"), "#!/bin/sh\necho hi\n");
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tach-tp-ws-"));
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    return { pluginDir, ws };
  }

  it("surfaces toolTargets in the preview and binds them into the fingerprint", async () => {
    const { pluginDir, ws } = fixture();
    const { plugin } = loadPlugin(pluginDir);
    expect(plugin).toBeDefined();
    const planA = await gatherToolPlan(plugin!, { platform: linux });
    const a = previewInstall(plugin!, ws, new Set(["claude"] as const), undefined, planA);
    expect(a.errors).toEqual([]);
    expect(a.toolTargets.map((t) => t.name)).toEqual(["gitleaks"]);

    // codex task-10 review D: finalUrl is recorded provenance, NOT bound — a benign signed/redirected URL
    // change must NOT re-prompt consent (the pinned sha256 is the real integrity gate).
    const planB = await gatherToolPlan(plugin!, { platform: linux, resolveFinalUrl: async () => "https://cdn.example.com/g?sig=abc" });
    const b = previewInstall(plugin!, ws, new Set(["claude"] as const), undefined, planB);
    expect(b.fingerprint).toBe(a.fingerprint);

    // but the PRESENCE of tool targets vs none IS bound: no tool plan → different fingerprint.
    const none = previewInstall(plugin!, ws, new Set(["claude"] as const));
    expect(none.toolTargets).toEqual([]);
    expect(none.fingerprint).not.toBe(a.fingerprint);

    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("an unsupported host surfaces a warning, not a tool target", async () => {
    const { pluginDir, ws } = fixture();
    const { plugin } = loadPlugin(pluginDir);
    const plan = await gatherToolPlan(plugin!, { platform: unsupported });
    const p = previewInstall(plugin!, ws, new Set(["claude"] as const), undefined, plan);
    expect(p.toolTargets).toEqual([]);
    expect(p.warnings.some((w) => /gitleaks/.test(w))).toBe(true);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

// keep the type import referenced
const _t: ToolPlan = { items: [], unsupported: [] };
void _t;
