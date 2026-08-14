import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installData, sha256FileStreaming } from "../../apps/vscode-extension/src/plugins/toolProvisioning.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "data-install-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function writeSrc(bytes: Buffer): { src: string; sha: string } {
  const src = path.join(tmp, "src.bin");
  fs.writeFileSync(src, bytes);
  return { src, sha: crypto.createHash("sha256").update(bytes).digest("hex") };
}

describe("installData (spec 284)", () => {
  it("installs sha-first content-addressed, read-only (0o400), NOT executable", () => {
    const { src, sha } = writeSrc(Buffer.from("ggml model bytes"));
    const dataDir = path.join(tmp, "data", "sha256");
    const r = installData(src, { dataDir, sha256: sha, fileName: "ggml-base.bin" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.installPath).toBe(path.join(dataDir, sha, "ggml-base.bin"));
    expect(r.reused).toBe(false);
    const mode = fs.statSync(r.installPath).mode & 0o777;
    expect(mode).toBe(0o400);
    expect(mode & 0o111).toBe(0); // no exec bit for anyone
    expect(sha256FileStreaming(r.installPath)).toBe(sha);
  });

  it("is idempotent — a hash-matching existing copy is reused", () => {
    const { src, sha } = writeSrc(Buffer.from("same"));
    const dataDir = path.join(tmp, "data", "sha256");
    expect(installData(src, { dataDir, sha256: sha, fileName: "m.bin" }).ok).toBe(true);
    const r2 = installData(src, { dataDir, sha256: sha, fileName: "m.bin" });
    expect(r2.ok && r2.reused).toBe(true);
  });

  it("fails closed when the source hash != the pinned sha256", () => {
    const { src } = writeSrc(Buffer.from("actual"));
    const r = installData(src, { dataDir: path.join(tmp, "d"), sha256: "f".repeat(64), fileName: "m.bin" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("BIN_SHA_MISMATCH");
  });

  it("fails closed on a content-address collision (same sha dir, different bytes already there)", () => {
    const { src, sha } = writeSrc(Buffer.from("orig"));
    const dataDir = path.join(tmp, "data", "sha256");
    const first = installData(src, { dataDir, sha256: sha, fileName: "m.bin" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // corrupt the installed blob in place (simulate a swap), then a re-install must NOT silently reuse.
    fs.chmodSync(first.installPath, 0o600);
    fs.writeFileSync(first.installPath, Buffer.from("tampered"));
    const r = installData(src, { dataDir, sha256: sha, fileName: "m.bin" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INSTALL_COLLISION");
  });

  it("on reuse, repairs a benign wrong mode to 0o400 (codex MEDIUM)", () => {
    const { src, sha } = writeSrc(Buffer.from("reuse-mode"));
    const dataDir = path.join(tmp, "data", "sha256");
    const first = installData(src, { dataDir, sha256: sha, fileName: "m.bin" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    fs.chmodSync(first.installPath, 0o500); // simulate a pre-existing blob with an exec bit
    const r = installData(src, { dataDir, sha256: sha, fileName: "m.bin" });
    expect(r.ok && r.reused).toBe(true);
    expect(fs.statSync(first.installPath).mode & 0o777).toBe(0o400); // repaired, no exec bit
  });

  it("streamed hash matches a whole-file hash (no chunk-boundary bug)", () => {
    const big = crypto.randomBytes(3 * (1 << 20) + 123); // > a few 1MiB chunks, non-aligned
    const { src, sha } = writeSrc(big);
    expect(sha256FileStreaming(src)).toBe(sha);
  });
});
