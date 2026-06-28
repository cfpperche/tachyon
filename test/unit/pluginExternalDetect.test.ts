import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectExternalTool, detectPackageManager, validateInstallArgv } from "../../src/plugins/externalTool.js";
import type { ExternalToolDecl } from "../../src/plugins/manifest.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const decl: ExternalToolDecl = { install: { apt: { argv: ["sudo", "apt-get", "install", "-y", "ffmpeg"] } }, manual: "x" };

describe("validateInstallArgv (spec 285 D3)", () => {
  it("accepts a leading sudo + a matching PM exe", () => {
    expect(validateInstallArgv("apt", ["sudo", "apt-get", "install", "-y", "ffmpeg"])).toEqual({ ok: true });
    expect(validateInstallArgv("brew", ["brew", "install", "whisper-cpp"])).toEqual({ ok: true });
  });
  it("REJECTS a first exe that doesn't match the declared PM family", () => {
    const r = validateInstallArgv("apt", ["sudo", "curl", "evil.sh"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/does not match the declared package manager 'apt'/);
  });
  it("REJECTS control chars + an over-long argv", () => {
    expect(validateInstallArgv("apt", ["apt-get", "in\nstall"]).ok).toBe(false);
    expect(validateInstallArgv("apt", Array(70).fill("apt-get")).ok).toBe(false);
    expect(validateInstallArgv("apt", []).ok).toBe(false);
  });
});

describe("detectExternalTool (spec 285 D4)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-detect-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("present when resolved to a trusted absolute path", () => {
    // a root-owned system binary is trusted; use a real one resolved by the injected resolver.
    const r = detectExternalTool("ffmpeg", decl, { resolve: () => "/bin/sh" }); // /bin/sh: root-owned, trusted ancestry
    expect(r.present).toBe(true);
  });
  it("missing when the binary is not found on a clean PATH", () => {
    const r = detectExternalTool("definitely-not-a-real-binary-xyz", decl, { resolve: () => null });
    expect(r.present).toBe(false);
    if (r.present) return;
    expect(r.reason).toMatch(/not found on a clean system PATH/);
  });
  it("missing when the detect probe fails", () => {
    const d2: ExternalToolDecl = { ...decl, detect: ["ffmpeg", "-version"] };
    const r = detectExternalTool("ffmpeg", d2, { resolve: () => "/bin/sh", runDetect: () => false });
    expect(r.present).toBe(false);
    if (r.present) return;
    expect(r.reason).toMatch(/detect probe did not succeed/);
  });
  it("rejects an untrusted (workspace-local, user-owned in a writable dir) resolution", () => {
    // a fake binary in a group/other-writable dir is NOT trusted even if resolved.
    fs.chmodSync(dir, 0o777);
    const fake = path.join(dir, "ffmpeg");
    fs.writeFileSync(fake, "#!/bin/sh\n"); fs.chmodSync(fake, 0o755);
    const r = detectExternalTool("ffmpeg", decl, { resolve: () => fake });
    expect(r.present).toBe(false);
    if (r.present) return;
    expect(r.reason).toMatch(/is not trusted/);
  });
});

describe("detectPackageManager (spec 285 D3)", () => {
  it("returns the first PM whose exe resolves trusted", () => {
    // inject a resolver that only knows brew → /bin/sh (trusted stand-in).
    const pm = detectPackageManager({ resolve: (n) => (n === "brew" ? "/bin/sh" : null) });
    expect(pm).toBe("brew");
  });
  it("returns null when no package manager is present", () => {
    expect(detectPackageManager({ resolve: () => null })).toBeNull();
  });
});
