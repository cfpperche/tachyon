import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { smokeCheck, detectHostTool, isTrustedExecPath, type PathStat } from "../../apps/vscode-extension/src/plugins/toolProvisioning.js";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** Write an executable shell-script "tool" that echoes a version line. */
function writeTool(dir: string, name: string, version: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "${name} version ${version}"\n`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

describe("smokeCheck", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-sm-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("accepts a runnable script tool and captures its --version output", () => {
    const p = writeTool(dir, "mytool", "1.2.3");
    const r = smokeCheck(p, { versionArgs: ["--version"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.magic).toBe("script");
      expect(r.output).toMatch(/version 1\.2\.3/);
    }
  });

  it("rejects a non-executable, non-magic file (BAD_MAGIC)", () => {
    const p = path.join(dir, "data.txt");
    fs.writeFileSync(p, "just text, no shebang");
    expect(smokeCheck(p)).toMatchObject({ ok: false, code: "BAD_MAGIC" });
  });

  it("fails closed on an unreadable path (UNREADABLE)", () => {
    expect(smokeCheck(path.join(dir, "nope"))).toMatchObject({ ok: false, code: "UNREADABLE" });
  });

  it("recognizes ELF magic (the host /bin/sh, if ELF)", () => {
    const buf = fs.readFileSync("/bin/sh").subarray(0, 4);
    if (buf[0] === 0x7f && buf[1] === 0x45) {
      const r = smokeCheck("/bin/sh", { versionArgs: ["-c", "exit 0"] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.magic).toBe("elf");
    }
  });
});

describe("isTrustedExecPath", () => {
  const UID = 1000;
  // a fake stat tree: /usr/local/bin/gitleaks (root-owned, 0755 dirs) is trusted.
  const trusted = (p: string): PathStat | null => {
    const map: Record<string, PathStat> = {
      "/usr/local/bin/gitleaks": { uid: 0, mode: 0o755, isFile: () => true },
      "/usr/local/bin": { uid: 0, mode: 0o755, isFile: () => false },
      "/usr/local": { uid: 0, mode: 0o755, isFile: () => false },
      "/usr": { uid: 0, mode: 0o755, isFile: () => false },
      "/": { uid: 0, mode: 0o755, isFile: () => false },
    };
    return map[p] ?? null;
  };

  it("trusts a root-owned binary under non-writable parents", () => {
    expect(isTrustedExecPath("/usr/local/bin/gitleaks", UID, trusted)).toEqual({ trusted: true });
  });

  it("rejects a world-writable parent (e.g. /tmp 1777)", () => {
    const stat = (p: string): PathStat | null =>
      p === "/tmp/gitleaks" ? { uid: UID, mode: 0o755, isFile: () => true } : p === "/tmp" ? { uid: 0, mode: 0o1777 & 0o777, isFile: () => false } : { uid: 0, mode: 0o755, isFile: () => false };
    const r = isTrustedExecPath("/tmp/gitleaks", UID, stat);
    expect(r.trusted).toBe(false);
    expect(r.reason).toMatch(/group\/other writable/);
  });

  it("rejects a binary owned by another user", () => {
    const stat = (p: string): PathStat | null => (p === "/usr/local/bin/gitleaks" ? { uid: 9999, mode: 0o755, isFile: () => true } : trusted(p));
    expect(isTrustedExecPath("/usr/local/bin/gitleaks", UID, stat).trusted).toBe(false);
  });
});

describe("detectHostTool", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-dt-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("detects a trusted host tool: path + version + hash (stat injected as trusted)", () => {
    const p = writeTool(dir, "gitleaks", "8.18.4");
    const trustedStat = () => ({ uid: process.getuid?.() ?? 0, mode: 0o755, isFile: () => true });
    const r = detectHostTool("gitleaks", { versionCommand: [p, "--version"], lookupPath: () => p, statPath: trustedStat });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(p);
      expect(r.version).toMatch(/8\.18\.4/);
      expect(r.hash).toBe(sha(fs.readFileSync(p)));
    }
  });

  it("returns NOT_FOUND when the tool is not on PATH", () => {
    expect(detectHostTool("ghost", { versionCommand: ["ghost", "--version"], lookupPath: () => null })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("rejects an untrusted path (UNTRUSTED_PATH)", () => {
    const p = writeTool(dir, "gitleaks", "8.18.4");
    const untrusted = () => ({ uid: 9999, mode: 0o777, isFile: () => true });
    expect(detectHostTool("gitleaks", { versionCommand: [p, "--version"], lookupPath: () => p, statPath: untrusted })).toMatchObject({ ok: false, code: "UNTRUSTED_PATH" });
  });

  it("honors allowedHostSha256 (HASH_NOT_ALLOWED on mismatch)", () => {
    const p = writeTool(dir, "gitleaks", "8.18.4");
    const trustedStat = () => ({ uid: process.getuid?.() ?? 0, mode: 0o755, isFile: () => true });
    const r = detectHostTool("gitleaks", { versionCommand: [p, "--version"], lookupPath: () => p, statPath: trustedStat, allowedHostSha256: sha("nope") });
    expect(r).toMatchObject({ ok: false, code: "HASH_NOT_ALLOWED" });
  });
});
