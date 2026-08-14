import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";
import { loadPlugin, previewInstall, applyInstall } from "../../src/plugins/engine.js";
import { buildInstallConsent } from "../../src/plugins/consentViewModel";
import { parseLockfile } from "@tachyon/engine/plugins/lockfile.js";
import { resolveExternalTool } from "../../src/plugins/externalTool.js";

let bundle: string;
let pluginDir: string;
let ws: string;

beforeAll(() => {
  bundle = path.join(os.tmpdir(), `tach-ext-resolver-${process.pid}.cjs`);
  esbuild.buildSync({ entryPoints: ["src/externalResolverEntry.ts"], bundle: true, outfile: bundle, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
});
afterAll(() => fs.rmSync(bundle, { force: true }));

beforeEach(() => {
  pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-ext-plug-"));
  fs.writeFileSync(path.join(pluginDir, "tachyon-plugin.json"), JSON.stringify({
    name: "tr", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" },
    externalTools: { ffmpeg: { detect: ["definitely-not-real-xyz"], install: { apt: { argv: ["sudo", "apt-get", "install", "-y", "ffmpeg"] } }, manual: "https://ffmpeg.org" } },
  }));
  fs.mkdirSync(path.join(pluginDir, "claude"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "claude", "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./gate.sh" }] }] }));
  fs.writeFileSync(path.join(pluginDir, "claude", "gate.sh"), "#!/bin/sh\necho hi\n");
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "tach-ext-ws-"));
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
});
afterEach(() => { fs.rmSync(pluginDir, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });

describe("engine — external-tool requirements (spec 285 Lane C)", () => {
  it("preview surfaces externalTargets (missing) + consent lists them informationally", () => {
    const { plugin } = loadPlugin(pluginDir);
    const pv = previewInstall(plugin!, ws, new Set(["claude"] as const));
    expect(pv.externalTargets).toHaveLength(1);
    expect(pv.externalTargets[0]).toMatchObject({ name: "ffmpeg", present: false, manual: "https://ffmpeg.org" });
    expect(pv.warnings.some((w) => /external tool 'ffmpeg' is not installed/.test(w))).toBe(true);
    const vm = buildInstallConsent(pv);
    expect(vm.externalTools?.[0]).toMatchObject({ name: "ffmpeg", present: false });
    expect(vm.requiresDataConfirm).toBeUndefined(); // not a data ack
  });

  it("install records the external requirement + materializes the _tachyon-external shim; resolver fails closed (tool absent)", async () => {
    const { plugin } = loadPlugin(pluginDir);
    const target = new Set(["claude"] as const);
    const pv = previewInstall(plugin!, ws, target);
    const r = await applyInstall(plugin!, pv, ws, target, { externalResolverBundlePath: bundle });
    expect(r.errors).toEqual([]);
    expect(r.installed).toBe(true);

    const lf = parseLockfile(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8")).lockfile!;
    expect(lf.plugins.tr.externalTools?.[0]).toEqual({ name: "ffmpeg", detect: ["definitely-not-real-xyz"], install: { apt: ["sudo", "apt-get", "install", "-y", "ffmpeg"] }, manual: "https://ffmpeg.org" });
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-external"))).toBe(true);

    // the resolver fails closed because the tool isn't actually installed (the detect probe can't run).
    const res = resolveExternalTool("tr", "ffmpeg", { workspaceRoot: ws });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("UNAVAILABLE");
    expect(res.detail).toMatch(/ffmpeg\.org/);
  });
});
