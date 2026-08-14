import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { materializeDataResolver, DATA_STORE_REL } from "../../src/plugins/dataLauncher.js";
import { serializeLockfile, LOCKFILE_REL_PATH, type Lockfile, type DataLock } from "@tachyon/engine/plugins/lockfile.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const BUNDLE = path.resolve("dist/data-resolver.cjs");
const haveBundle = fs.existsSync(BUNDLE);

let ws: string;
const BYTES = Buffer.from("ggml model weights for the shim test");
const SHA = crypto.createHash("sha256").update(BYTES).digest("hex");
const FILE = "ggml-base.bin";

function lock(): DataLock {
  return { name: "model", resolvedPlatform: "any", version: "base", contentSha256: SHA, fileName: FILE, installPath: path.posix.join(DATA_STORE_REL, SHA, FILE), declaredUrl: "https://h/m.bin", finalUrl: "https://cdn/m.bin" };
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "data-shim-"));
  fs.mkdirSync(path.join(ws, ".tachyon", "data"), { recursive: true });
  const lf: Lockfile = { schemaVersion: 1, plugins: { tr: { name: "tr", version: "1.0.0", runtimes: ["claude"], targets: [], data: [lock()] } } };
  fs.writeFileSync(path.join(ws, LOCKFILE_REL_PATH), serializeLockfile(lf));
  const blob = path.join(ws, lock().installPath);
  fs.mkdirSync(path.dirname(blob), { recursive: true });
  fs.writeFileSync(blob, BYTES);
  fs.chmodSync(blob, 0o400);
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe.skipIf(!haveBundle)("_tachyon-data shim — end-to-end (spec 284 B3)", () => {
  it("materializes the shim + bundle and resolves a blob to its path (exit 0)", () => {
    const binDir = path.join(ws, ".tachyon", "bin");
    const r = materializeDataResolver(binDir, { nodePath: process.execPath, resolverBundlePath: BUNDLE });
    expect(fs.existsSync(r.shimPath)).toBe(true);
    expect(fs.existsSync(r.validatorPath)).toBe(true);
    expect(r.shimSha256).toMatch(/^[0-9a-f]{64}$/);
    const out = execFileSync(r.shimPath, ["tr", "model"], { encoding: "utf8" }).trim();
    expect(out).toBe(path.join(ws, lock().installPath));
  });

  it("fails closed (nonzero + stderr) for an unknown data artifact", () => {
    const binDir = path.join(ws, ".tachyon", "bin");
    materializeDataResolver(binDir, { nodePath: process.execPath, resolverBundlePath: BUNDLE });
    let code = 0;
    let stderr = "";
    try {
      execFileSync(path.join(binDir, "_tachyon-data"), ["tr", "nope"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: Buffer }).stderr);
    }
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/DATA_NOT_FOUND/);
  });
});
