import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import * as tarStream from "tar-stream";
import { extractArchiveMember } from "../../apps/vscode-extension/src/plugins/toolProvisioning.js";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

interface Entry {
  name: string;
  content?: Buffer | string;
  type?: "file" | "directory" | "symlink";
  linkname?: string;
  mode?: number;
}

/** Build a real tar.gz buffer from crafted entries (incl. malicious shapes). */
function makeTarGz(entries: Entry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarStream.pack();
    for (const e of entries) {
      if (e.type === "symlink") pack.entry({ name: e.name, type: "symlink", linkname: e.linkname ?? "/etc/passwd" });
      else if (e.type === "directory") pack.entry({ name: e.name, type: "directory" });
      else pack.entry({ name: e.name, mode: e.mode ?? 0o644 }, e.content ?? "");
    }
    pack.finalize();
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(zlib.gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
  });
}

describe("extractArchiveMember", () => {
  let dir: string;
  const BIN = Buffer.from("#!/bin/sh\necho gitleaks v8\n");
  const BIN_SHA = sha(BIN);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-ar-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function writeArchive(entries: Entry[]): Promise<string> {
    const p = path.join(dir, "art.tar.gz");
    fs.writeFileSync(p, await makeTarGz(entries));
    return p;
  }

  it("extracts the single innerPath regular file and verifies binSha256", async () => {
    const art = await writeArchive([{ name: "README", content: "hi" }, { name: "bin/gitleaks", content: BIN }, { name: "LICENSE", content: "MIT" }]);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(sha(fs.readFileSync(r.tempPath))).toBe(BIN_SHA);
  });

  it("normalizes a leading './' innerPath and a long (pax/GNU) name safely", async () => {
    const longName = `bin/${"d".repeat(150)}/gitleaks`;
    const art = await writeArchive([{ name: `./${longName}`, content: BIN }]);
    const r = await extractArchiveMember(art, { innerPath: longName, binSha256: BIN_SHA, destDir: dir });
    expect(r.ok).toBe(true);
  });

  it("rejects a symlink entry anywhere (DANGEROUS_ENTRY)", async () => {
    const art = await writeArchive([{ name: "bin/gitleaks", content: BIN }, { name: "evil", type: "symlink", linkname: "/etc/passwd" }]);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir });
    expect(r).toMatchObject({ ok: false, code: "DANGEROUS_ENTRY" });
  });

  it("rejects a path-traversal entry (BAD_ENTRY_PATH)", async () => {
    const art = await writeArchive([{ name: "../../etc/cron.d/evil", content: "x" }]);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir });
    expect(r).toMatchObject({ ok: false, code: "BAD_ENTRY_PATH" });
  });

  it("rejects a case-folded duplicate entry (DUPLICATE_ENTRY)", async () => {
    const art = await writeArchive([{ name: "bin/gitleaks", content: BIN }, { name: "bin/GitLeaks", content: "other" }]);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir });
    expect(r).toMatchObject({ ok: false, code: "DUPLICATE_ENTRY" });
  });

  it("rejects when innerPath is a directory, not a file (NOT_A_FILE)", async () => {
    const art = await writeArchive([{ name: "bin/gitleaks", type: "directory" }]);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir });
    expect(r).toMatchObject({ ok: false, code: "NOT_A_FILE" });
  });

  it("fails closed when innerPath is absent (INNER_NOT_FOUND)", async () => {
    const art = await writeArchive([{ name: "README", content: "hi" }]);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir });
    expect(r).toMatchObject({ ok: false, code: "INNER_NOT_FOUND" });
  });

  it("fails closed when the extracted bytes don't match binSha256", async () => {
    const art = await writeArchive([{ name: "bin/gitleaks", content: BIN }]);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: sha("different"), destDir: dir });
    expect(r).toMatchObject({ ok: false, code: "BIN_SHA_MISMATCH" });
  });

  it("enforces the entry-count cap (TOO_MANY_ENTRIES)", async () => {
    const many: Entry[] = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, content: "x" }));
    const art = await writeArchive(many);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir, maxEntries: 5 });
    expect(r).toMatchObject({ ok: false, code: "TOO_MANY_ENTRIES" });
  });

  it("enforces the decompressed-size cap (zip-bomb / DECOMPRESSED_TOO_LARGE)", async () => {
    const big = Buffer.alloc(256 * 1024, 0); // compresses tiny, expands past a small cap
    const art = await writeArchive([{ name: "bin/gitleaks", content: big }]);
    const r = await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: sha(big), destDir: dir, maxDecompressedBytes: 4096 });
    expect(r).toMatchObject({ ok: false, code: "DECOMPRESSED_TOO_LARGE" });
  });

  it("fails closed on non-gzip / corrupt input (DECOMPRESS_ERROR)", async () => {
    const p = path.join(dir, "not.gz");
    fs.writeFileSync(p, "this is not gzip");
    const r = await extractArchiveMember(p, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir });
    expect(r).toMatchObject({ ok: false, code: "DECOMPRESS_ERROR" });
  });

  it("leaves no temp behind on a rejected extraction", async () => {
    const art = await writeArchive([{ name: "bin/gitleaks", content: BIN }, { name: "evil", type: "symlink" }]);
    await extractArchiveMember(art, { innerPath: "bin/gitleaks", binSha256: BIN_SHA, destDir: dir });
    await new Promise((res) => setTimeout(res, 50));
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(".ex-")).length).toBe(0);
  });
});
