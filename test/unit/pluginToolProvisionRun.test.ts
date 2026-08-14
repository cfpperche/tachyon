import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as esbuild from "esbuild";
import { loadPlugin, previewInstall, applyInstall, previewRemove, applyRemove } from "../../src/plugins/engine.js";
import { rehydrateTools } from "../../src/plugins/toolProvisionRun.js";
import { gatherToolPlan } from "../../src/plugins/toolPlan.js";
import { resolveHostPlatform } from "../../src/plugins/toolPlatform.js";
import { parseLockfile } from "@tachyon/engine/plugins/lockfile.js";
import { tlsKeypair } from "../helpers/tlsFixture.js";

const kp = tlsKeypair();
const host = resolveHostPlatform();
const HOST_KEY = host.ok ? host.keys[0] : null;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

// a runnable script "tool" that answers --version (smoke-check: shebang magic + --version).
const TOOL_BYTES = Buffer.from('#!/bin/sh\nif [ "$1" = "--version" ]; then echo "mytool 1.0.0"; fi\n');
const TOOL_SHA = sha(TOOL_BYTES);

describe.skipIf(!kp || !HOST_KEY)("applyInstall — tool provisioning (10b, real https fixture)", () => {
  let server: https.Server;
  let base: string;
  let bundle: string;

  beforeAll(async () => {
    server = https.createServer({ key: kp!.key, cert: kp!.cert }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(TOOL_BYTES);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    bundle = path.join(os.tmpdir(), `tach-launcher-10b-${process.pid}.cjs`);
    esbuild.buildSync({ entryPoints: ["src/toolLauncherEntry.ts"], bundle: true, outfile: bundle, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(bundle, { force: true });
  });

  let pluginDir: string;
  let ws: string;
  beforeEach(() => {
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-10b-plug-"));
    fs.writeFileSync(
      path.join(pluginDir, "tachyon-plugin.json"),
      JSON.stringify({
        name: "cg", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" },
        tools: { mytool: { version: "1.0.0", platforms: { [HOST_KEY as string]: { url: `${base}/mytool`, sha256: TOOL_SHA } } } },
      }),
    );
    fs.mkdirSync(path.join(pluginDir, "claude"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "claude", "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./gate.sh" }] }] }));
    fs.writeFileSync(path.join(pluginDir, "claude", "gate.sh"), "#!/bin/sh\necho hi\n");
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "tach-10b-ws-"));
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  async function doInstall(over: Record<string, unknown> = {}) {
    const { plugin } = loadPlugin(pluginDir);
    const target = new Set(["claude"] as const);
    const toolPlan = await gatherToolPlan(plugin!);
    const preview = previewInstall(plugin!, ws, target, undefined, toolPlan);
    return applyInstall(plugin!, preview, ws, target, { toolConfirmed: true, launcherBundlePath: bundle, toolTlsCa: kp!.cert, ...over });
  }

  it("provisions the tool into the content-addressed store + records lock + launcher", async () => {
    const res = await doInstall();
    expect(res.errors).toEqual([]);
    expect(res.installed).toBe(true);

    const installPath = path.join(ws, ".tachyon/bin/mytool", TOOL_SHA, "mytool");
    expect(fs.existsSync(installPath)).toBe(true);
    expect(fs.statSync(installPath).mode & 0o777).toBe(0o500);
    expect(sha(fs.readFileSync(installPath))).toBe(TOOL_SHA);

    // launcher shim + validator materialized
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-tool"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-tool.js"))).toBe(true);

    // lockfile records the tool + the launcher
    const lf = parseLockfile(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8")).lockfile!;
    expect(lf.plugins.cg.tools?.[0]).toMatchObject({ name: "mytool", source: "fetched", binSha256: TOOL_SHA, resolvedPlatform: HOST_KEY });
    expect(lf.launcher).toMatchObject({ nodePath: process.execPath });
    expect(lf.launcher?.validatorSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fail-closes without the tool acknowledgement (toolConfirmed)", async () => {
    const res = await doInstall({ toolConfirmed: false });
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/tool acknowledgement/);
  });

  it("applyRemove deletes the provisioned binary + launcher when no plugin references it (task 11)", async () => {
    const inst = await doInstall();
    expect(inst.installed).toBe(true);
    const binPath = path.join(ws, ".tachyon/bin/mytool", TOOL_SHA, "mytool");
    expect(fs.existsSync(binPath)).toBe(true);

    const prev = previewRemove("cg", ws);
    const rem = await applyRemove("cg", ws, { expectedFingerprint: prev.fingerprint });
    expect(rem.removed).toBe(true);
    expect(fs.existsSync(binPath)).toBe(false); // binary gone
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-tool"))).toBe(false); // launcher gone (no tools left)
    // removing the only plugin empties the lockfile → it is deleted (spec 264 behavior), so no launcher record survives.
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins.lock.json"))).toBe(false);
  });

  it("rehydrateTools re-provisions from the lockfile after .tachyon/bin is wiped (clone/CI)", async () => {
    const inst = await doInstall();
    expect(inst.installed).toBe(true);
    const binPath = path.join(ws, ".tachyon/bin/mytool", TOOL_SHA, "mytool");

    // simulate a fresh clone: the lockfile is committed but .tachyon/bin (gitignored) is absent.
    fs.rmSync(path.join(ws, ".tachyon/bin"), { recursive: true, force: true });
    expect(fs.existsSync(binPath)).toBe(false);

    const rh = await rehydrateTools(ws, { launcherBundlePath: bundle, tlsCa: kp!.cert });
    expect(rh.errors).toEqual([]);
    expect(rh.rehydrated).toBe(1);
    expect(fs.existsSync(binPath)).toBe(true); // binary back
    expect(sha(fs.readFileSync(binPath))).toBe(TOOL_SHA);
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-tool"))).toBe(true); // launcher back
  });

  it("rolls back on a checksum mismatch — no binary, no lockfile tool entry", async () => {
    // point the manifest at the fixture but pin a WRONG sha → artifact verify fails.
    fs.writeFileSync(
      path.join(pluginDir, "tachyon-plugin.json"),
      JSON.stringify({
        name: "cg", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" },
        tools: { mytool: { version: "1.0.0", platforms: { [HOST_KEY as string]: { url: `${base}/mytool`, sha256: "f".repeat(64) } } } },
      }),
    );
    const res = await doInstall();
    expect(res.installed).toBe(false);
    expect(res.errors.join(" ")).toMatch(/checksum|SHA_MISMATCH/);
    // no binary landed, no lockfile (provisioning aborted before any payload/lockfile write)
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/mytool"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins.lock.json"))).toBe(false);
  });
});
