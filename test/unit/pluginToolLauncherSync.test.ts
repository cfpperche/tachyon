import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { syncToolLauncher, rehydrateTools } from "../../src/plugins/toolProvisionRun.js";
import { parseLockfile, serializeLockfile, type Lockfile } from "@tachyon/engine/plugins/lockfile.js";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeBundle(dir: string, content: string): string {
  const file = path.join(dir, "tool-launcher.cjs");
  fs.writeFileSync(file, content);
  return file;
}

function writeHostToolLock(ws: string, launcher = { nodePath: process.execPath, shimSha256: HEX_A, validatorSha256: HEX_B }): void {
  const lockfile: Lockfile = {
    schemaVersion: 1,
    launcher,
    plugins: {
      cg: {
        name: "cg",
        version: "1.0.0",
        runtimes: ["claude"],
        targets: [],
        tools: [{
          name: "guard",
          source: "host-provided",
          resolvedPlatform: "linux-x64-glibc",
          version: "1.0.0",
          binSha256: HEX_A,
          exeName: "guard",
          installPath: process.execPath,
          hostDetected: { path: process.execPath, version: "node", hash: HEX_A },
        }],
      },
    },
  };
  fs.mkdirSync(path.join(ws, ".tachyon"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".tachyon/plugins.lock.json"), serializeLockfile(lockfile));
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("tool launcher freshness sync", () => {
  it("refreshes stale workspace launcher bytes from the current bundle and updates the launcher lock", () => {
    const ws = tmpDir("tach-launcher-sync-ws-");
    const bundleDir = tmpDir("tach-launcher-sync-bundle-");
    const bundle = writeBundle(bundleDir, "module.exports = 'fresh';\n");
    writeHostToolLock(ws);

    const first = syncToolLauncher(ws, { launcherBundlePath: bundle });
    expect(first.errors).toEqual([]);
    expect(first.refreshed).toBe(true);
    expect(sha(fs.readFileSync(path.join(ws, ".tachyon/bin/_tachyon-tool.js")))).toBe(sha("module.exports = 'fresh';\n"));

    const parsed = parseLockfile(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8")).lockfile!;
    expect(parsed.launcher?.validatorSha256).toBe(sha("module.exports = 'fresh';\n"));
    expect(parsed.launcher?.shimSha256).toMatch(/^[0-9a-f]{64}$/);

    const second = syncToolLauncher(ws, { launcherBundlePath: bundle });
    expect(second.errors).toEqual([]);
    expect(second.refreshed).toBe(false);
  });

  it("can refresh activation-time launcher bytes without rewriting the committed lockfile", () => {
    const ws = tmpDir("tach-launcher-activation-ws-");
    const bundleDir = tmpDir("tach-launcher-activation-bundle-");
    const bundle = writeBundle(bundleDir, "module.exports = 'activation-fresh';\n");
    writeHostToolLock(ws);
    const before = fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8");

    const r = syncToolLauncher(ws, { launcherBundlePath: bundle, updateLockfile: false });
    expect(r.errors).toEqual([]);
    expect(r.refreshed).toBe(true);
    expect(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8")).toBe(before);
    expect(sha(fs.readFileSync(path.join(ws, ".tachyon/bin/_tachyon-tool.js")))).toBe(sha("module.exports = 'activation-fresh';\n"));
  });

  it("rehydrate refreshes the launcher even when every tool is host-provided and no download is needed", async () => {
    const ws = tmpDir("tach-launcher-host-ws-");
    const bundleDir = tmpDir("tach-launcher-host-bundle-");
    const bundle = writeBundle(bundleDir, "module.exports = 'host-fresh';\n");
    writeHostToolLock(ws);

    const r = await rehydrateTools(ws, { launcherBundlePath: bundle });
    expect(r.errors).toEqual([]);
    expect(r.rehydrated).toBe(0);
    expect(r.launcher?.validatorSha256).toBe(sha("module.exports = 'host-fresh';\n"));
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-tool"))).toBe(true);
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/_tachyon-tool.js"))).toBe(true);
  });
});
