import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { verifyArtifact, installExecutable, sha256File } from "../../src/plugins/toolProvisioning.js";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

describe("verifyArtifact", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-vf-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("accepts a matching sha256", () => {
    const p = path.join(dir, "a");
    fs.writeFileSync(p, "hello");
    expect(verifyArtifact(p, sha("hello"))).toEqual({ ok: true, sha256: sha("hello") });
  });

  it("fails closed on a mismatch", () => {
    const p = path.join(dir, "a");
    fs.writeFileSync(p, "hello");
    expect(verifyArtifact(p, sha("goodbye"))).toMatchObject({ ok: false, code: "SHA_MISMATCH" });
  });

  it("fails closed on an unreadable file", () => {
    expect(verifyArtifact(path.join(dir, "nope"), sha("x"))).toMatchObject({ ok: false, code: "UNREADABLE" });
  });
});

describe("installExecutable", () => {
  let root: string;
  let binDir: string;
  let src: string;
  const BYTES = Buffer.from("#!/bin/sh\necho tool\n");
  const BIN_SHA = sha(BYTES);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tach-inst-"));
    binDir = path.join(root, ".tachyon", "bin");
    src = path.join(root, "downloaded.tmp");
    fs.writeFileSync(src, BYTES);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("installs to the content-addressed path at mode 0500, nlink 1", () => {
    const r = installExecutable(src, { binDir, name: "gitleaks", exeName: "gitleaks", binSha256: BIN_SHA });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.installPath).toBe(path.join(binDir, "gitleaks", BIN_SHA, "gitleaks"));
      expect(r.reused).toBe(false);
      const st = fs.statSync(r.installPath);
      expect(st.mode & 0o777).toBe(0o500);
      expect(st.nlink).toBe(1);
      expect(sha256File(r.installPath)).toBe(BIN_SHA);
    }
  });

  it("is idempotent — a second install of the same bytes reuses the copy", () => {
    const a = installExecutable(src, { binDir, name: "gitleaks", exeName: "gitleaks", binSha256: BIN_SHA });
    const b = installExecutable(src, { binDir, name: "gitleaks", exeName: "gitleaks", binSha256: BIN_SHA });
    expect(a.ok && b.ok).toBe(true);
    if (b.ok) expect(b.reused).toBe(true);
  });

  it("fails closed when the source hash != declared binSha256", () => {
    const r = installExecutable(src, { binDir, name: "gitleaks", exeName: "gitleaks", binSha256: sha("other") });
    expect(r).toMatchObject({ ok: false, code: "BIN_SHA_MISMATCH" });
  });

  it("refuses to overwrite a content-addressed path that holds DIFFERENT bytes (collision)", () => {
    const dir = path.join(binDir, "gitleaks", BIN_SHA);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "gitleaks"), "tampered-bytes");
    const r = installExecutable(src, { binDir, name: "gitleaks", exeName: "gitleaks", binSha256: BIN_SHA });
    expect(r).toMatchObject({ ok: false, code: "INSTALL_COLLISION" });
  });

  it("creates 0700 parent dirs", () => {
    const r = installExecutable(src, { binDir, name: "gitleaks", exeName: "gitleaks", binSha256: BIN_SHA });
    expect(r.ok).toBe(true);
    const nameDir = path.join(binDir, "gitleaks");
    expect(fs.statSync(nameDir).mode & 0o777).toBe(0o700);
  });
});
