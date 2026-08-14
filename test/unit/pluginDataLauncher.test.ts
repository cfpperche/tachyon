import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveDataForAccess, DATA_STORE_REL } from "../../src/plugins/dataLauncher.js";
import { serializeLockfile, LOCKFILE_REL_PATH, type Lockfile, type DataLock } from "@tachyon/engine/plugins/lockfile.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

let ws: string;
const BYTES = Buffer.from("ggml model weights");
const SHA = crypto.createHash("sha256").update(BYTES).digest("hex");
const FILE = "ggml-base.bin";

function dataLock(over: Partial<DataLock> = {}): DataLock {
  return {
    name: "model", resolvedPlatform: "any", version: "base", contentSha256: SHA, fileName: FILE,
    installPath: path.posix.join(DATA_STORE_REL, SHA, FILE), declaredUrl: "https://h/m.bin", finalUrl: "https://cdn/m.bin", ...over,
  };
}

/** Build a workspace with a lockfile + an installed blob; return the absolute blob path for tampering. */
function setup(lock: DataLock = dataLock(), bytes: Buffer = BYTES, mode = 0o400): string {
  fs.mkdirSync(path.join(ws, ".tachyon", "data"), { recursive: true });
  const lockfile: Lockfile = { schemaVersion: 1, plugins: { tr: { name: "tr", version: "1.0.0", runtimes: ["claude"], targets: [], data: [lock] } } };
  fs.mkdirSync(path.dirname(path.join(ws, LOCKFILE_REL_PATH)), { recursive: true });
  fs.writeFileSync(path.join(ws, LOCKFILE_REL_PATH), serializeLockfile(lockfile));
  const blob = path.join(ws, lock.installPath);
  fs.mkdirSync(path.dirname(blob), { recursive: true });
  fs.writeFileSync(blob, bytes);
  fs.chmodSync(blob, mode);
  return blob;
}

beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), "data-resolve-")); });
afterEach(() => { try { fs.chmodSync(ws, 0o700); } catch { /* */ } fs.rmSync(ws, { recursive: true, force: true }); });

describe("resolveDataForAccess (spec 284)", () => {
  it("resolves a valid, hash-matching, read-only blob to its absolute path", () => {
    const blob = setup();
    const r = resolveDataForAccess("tr", "model", { workspaceRoot: ws });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dataPath).toBe(blob);
    expect(r.contentSha256).toBe(SHA);
  });

  it("fail-closed when the lockfile is absent (rehydrate required)", () => {
    const r = resolveDataForAccess("tr", "model", { workspaceRoot: ws });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("REHYDRATE_REQUIRED");
  });

  it("fail-closed PLUGIN_NOT_FOUND / DATA_NOT_FOUND (plugin-scoped)", () => {
    setup();
    expect((resolveDataForAccess("nope", "model", { workspaceRoot: ws }) as { code: string }).code).toBe("PLUGIN_NOT_FOUND");
    expect((resolveDataForAccess("tr", "nope", { workspaceRoot: ws }) as { code: string }).code).toBe("DATA_NOT_FOUND");
  });

  it("fail-closed HASH_MISMATCH on a swapped blob (resolve-time integrity)", () => {
    const blob = setup();
    fs.chmodSync(blob, 0o600);
    fs.writeFileSync(blob, Buffer.from("tampered"));
    fs.chmodSync(blob, 0o400);
    const r = resolveDataForAccess("tr", "model", { workspaceRoot: ws });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("HASH_MISMATCH");
  });

  it("fail-closed EXECUTABLE when the blob has an exec bit", () => {
    setup(dataLock(), BYTES, 0o500);
    const r = resolveDataForAccess("tr", "model", { workspaceRoot: ws });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("EXECUTABLE");
  });

  it("fail-closed BAD_INSTALL_PATH when installPath != the content address", () => {
    setup(dataLock({ installPath: ".tachyon/data/sha256/elsewhere/x.bin" }));
    const r = resolveDataForAccess("tr", "model", { workspaceRoot: ws });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("BAD_INSTALL_PATH");
  });

  it("fail-closed when the blob is a symlink (O_NOFOLLOW)", () => {
    setup();
    const blob = path.join(ws, dataLock().installPath);
    const real = path.join(ws, "real.bin");
    fs.renameSync(blob, real);
    fs.symlinkSync(real, blob);
    const r = resolveDataForAccess("tr", "model", { workspaceRoot: ws });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("OPEN_FAILED");
  });
});
