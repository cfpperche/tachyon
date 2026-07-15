import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("spec 382 — retired Extension Host Bridge proxy", () => {
  it("ships one engine-owned Bridge lifecycle with no proxy or in-process fallback", () => {
    const root = process.cwd();
    const workspace = fs.readFileSync(path.join(root, "src/workspace/Workspace.ts"), "utf8");
    const build = fs.readFileSync(path.join(root, "esbuild.mjs"), "utf8");
    const manifest = fs.readFileSync(path.join(root, "package.json"), "utf8");

    for (const relative of [
      "src/bridge/PersistentBridgeService.ts",
      "src/bridge/persistentProxyDaemon.ts",
      "src/bridge/persistentProxyProtocol.ts",
      "scripts/dogfood/persistent-bridge.mjs",
    ]) {
      expect(fs.existsSync(path.join(root, relative)), relative).toBe(false);
    }
    expect(workspace).not.toMatch(/PersistentBridgeService|persistentBridge|degradeToInProcessBridge/);
    expect(workspace).not.toMatch(/static async create\(/);
    expect(workspace.match(/clientRebind\?\.onListenerReady\(\)/g)).toHaveLength(1);
    expect(build).not.toMatch(/const persistentBridgeDaemon|persistentProxyDaemon\.ts/);
    expect(build).toContain('rmSync("dist/persistent-bridge-daemon.cjs", { force: true })');
    expect(manifest).not.toContain("test/unit/persistentBridgeProxy.test.ts");
  });
});
