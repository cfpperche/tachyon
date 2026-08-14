import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as esbuild from "esbuild";
import { loadPlugin, previewInstall, applyInstall, applyRemove, previewRemove } from "../../src/plugins/engine.js";
import { gatherDataPlan } from "../../src/plugins/dataPlan.js";
import { rehydrateData } from "../../src/plugins/toolProvisionRun.js";
import { buildInstallConsent } from "../../src/plugins/consentViewModel";
import { parseLockfile } from "@tachyon/engine/plugins/lockfile.js";
import { tlsKeypair } from "../helpers/tlsFixture.js";

const kp = tlsKeypair();
const MODEL = Buffer.from("ggml model weights for the engine e2e test");
const SHA = crypto.createHash("sha256").update(MODEL).digest("hex");
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

describe.skipIf(!kp)("engine — data-artifact install/remove (spec 284 Lane C)", () => {
  let server: https.Server;
  let base: string;
  let bundle: string;
  let pluginDir: string;
  let ws: string;

  beforeAll(async () => {
    server = https.createServer({ key: kp!.key, cert: kp!.cert }, (_req, res) => { res.writeHead(200); res.end(MODEL); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    bundle = path.join(os.tmpdir(), `tach-data-resolver-${process.pid}.cjs`);
    esbuild.buildSync({ entryPoints: ["src/dataResolverEntry.ts"], bundle: true, outfile: bundle, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); fs.rmSync(bundle, { force: true }); });

  beforeEach(() => {
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-data-plug-"));
    fs.writeFileSync(path.join(pluginDir, "tachyon-plugin.json"), JSON.stringify({
      name: "tr", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" },
      data: { model: { version: "base", fileName: "ggml-base.bin", url: `${base}/m.bin`, sha256: SHA } },
    }));
    fs.mkdirSync(path.join(pluginDir, "claude"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "claude", "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./gate.sh" }] }] }));
    fs.writeFileSync(path.join(pluginDir, "claude", "gate.sh"), "#!/bin/sh\necho hi\n");
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "tach-data-ws-"));
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  });
  afterEach(() => { fs.rmSync(pluginDir, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });

  async function preview() {
    const { plugin } = loadPlugin(pluginDir);
    const target = new Set(["claude"] as const);
    const dataPlan = await gatherDataPlan(plugin!);
    return { plugin: plugin!, target, pv: previewInstall(plugin!, ws, target, undefined, undefined, dataPlan) };
  }

  it("preview surfaces dataTargets; consent requires the data ack", async () => {
    const { pv } = await preview();
    expect(pv.dataTargets).toHaveLength(1);
    const vm = buildInstallConsent(pv);
    expect(vm.requiresDataConfirm).toBe(true);
    expect(vm.data?.[0]).toMatchObject({ name: "model", sha256: SHA, platform: "any" });
    expect(vm.requiresToolConfirm).toBeUndefined(); // data is NOT a tool
  });

  it("fails closed without the data acknowledgement", async () => {
    const { plugin, target, pv } = await preview();
    const r = await applyInstall(plugin, pv, ws, target, { dataResolverBundlePath: bundle, toolTlsCa: kp!.cert });
    expect(r.installed).toBe(false);
    expect(r.errors.join(" ")).toMatch(/data acknowledgement/);
  });

  it("installs the data blob + resolver, records lockfile.data + the data launcher hashes; remove frees them", async () => {
    const { plugin, target, pv } = await preview();
    const r = await applyInstall(plugin, pv, ws, target, { dataConfirmed: true, dataResolverBundlePath: bundle, toolTlsCa: kp!.cert });
    expect(r.errors).toEqual([]);
    expect(r.installed).toBe(true);

    const blob = path.join(ws, ".tachyon/data/sha256", SHA, "ggml-base.bin");
    expect(fs.existsSync(blob)).toBe(true);
    expect(fs.statSync(blob).mode & 0o777).toBe(0o400);
    expect(sha(fs.readFileSync(blob))).toBe(SHA);
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-data"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-data.js"))).toBe(true);

    const lf = parseLockfile(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8")).lockfile!;
    expect(lf.plugins.tr.data?.[0]).toMatchObject({ name: "model", contentSha256: SHA, resolvedPlatform: "any", fileName: "ggml-base.bin", installPath: `.tachyon/data/sha256/${SHA}/ggml-base.bin` });
    expect(lf.launcher?.dataShimSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lf.launcher?.shimSha256).toBeUndefined(); // data-only plugin → no tool launcher pair

    // remove → blob + shim gone, lockfile entry dropped
    const rp = previewRemove("tr", ws);
    const rem = await applyRemove("tr", ws, { expectedFingerprint: rp.fingerprint });
    expect(rem.removed).toBe(true);
    expect(fs.existsSync(blob)).toBe(false);
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-data"))).toBe(false);
    // removing the only plugin empties (and may delete) the lockfile — either way: no tr entry, no launcher.
    const lockPath = path.join(ws, ".tachyon/plugins.lock.json");
    if (fs.existsSync(lockPath)) {
      const lf2 = parseLockfile(fs.readFileSync(lockPath, "utf8")).lockfile!;
      expect(lf2.plugins.tr).toBeUndefined();
      expect(lf2.launcher).toBeUndefined();
    }
  });

  /** A second plugin pinning the SAME bytes (same sha) under a DIFFERENT fileName. */
  function makeSharedPlugin(name: string, fileName: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tach-data-${name}-`));
    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({
      name, version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" },
      data: { model: { version: "base", fileName, url: `${base}/m.bin`, sha256: SHA } },
    }));
    fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, "claude", "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./gate.sh" }] }] }));
    fs.writeFileSync(path.join(dir, "claude", "gate.sh"), "#!/bin/sh\necho hi\n");
    return dir;
  }
  async function installPlugin(dir: string) {
    const { plugin } = loadPlugin(dir);
    const target = new Set(["claude"] as const);
    const dataPlan = await gatherDataPlan(plugin!);
    const pv = previewInstall(plugin!, ws, target, undefined, undefined, dataPlan);
    return applyInstall(plugin!, pv, ws, target, { dataConfirmed: true, dataResolverBundlePath: bundle, toolTlsCa: kp!.cert });
  }

  it("BLOCKER regression — removing one plugin keeps a blob still referenced by another (shared sha)", async () => {
    const a = makeSharedPlugin("plug-a", "a.bin");
    const b = makeSharedPlugin("plug-b", "b.bin");
    try {
      expect((await installPlugin(a)).installed).toBe(true);
      expect((await installPlugin(b)).installed).toBe(true);
      const blobDir = path.join(ws, ".tachyon/data/sha256", SHA);
      expect(fs.existsSync(blobDir)).toBe(true);
      // remove plug-a — plug-b still references the same sha → the shared blob dir MUST survive.
      const rp = previewRemove("plug-a", ws);
      expect((await applyRemove("plug-a", ws, { expectedFingerprint: rp.fingerprint })).removed).toBe(true);
      expect(fs.existsSync(blobDir)).toBe(true);
      const lf = parseLockfile(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8")).lockfile!;
      expect(lf.plugins["plug-b"].data?.[0].contentSha256).toBe(SHA);
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  });

  it("HIGH regression — clone rehydrate re-fetches the blob AND re-materializes the _tachyon-data shim", async () => {
    const { plugin, target, pv } = await preview();
    expect((await applyInstall(plugin, pv, ws, target, { dataConfirmed: true, dataResolverBundlePath: bundle, toolTlsCa: kp!.cert })).installed).toBe(true);
    // simulate a fresh clone: both gitignored dirs wiped, only the lockfile survives.
    fs.rmSync(path.join(ws, ".tachyon/bin"), { recursive: true, force: true });
    fs.rmSync(path.join(ws, ".tachyon/data"), { recursive: true, force: true });
    const r = await rehydrateData(ws, { resolverBundlePath: bundle, tlsCa: kp!.cert });
    expect(r.errors).toEqual([]);
    expect(r.rehydrated).toBe(1);
    expect(fs.existsSync(path.join(ws, ".tachyon/data/sha256", SHA, "ggml-base.bin"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-data"))).toBe(true);
    const lf = parseLockfile(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8")).lockfile!;
    expect(lf.launcher?.dataShimSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
