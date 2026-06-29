import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectExternalTool, detectExternalToolPresence, resolveOnCleanPathNoSpawn, candidateNames, detectPackageManager, validateInstallArgv, adaptLockedInstall, buildAssistedInstall } from "../../src/plugins/externalTool.js";
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
    expect(r.reason).toMatch(/must be the bare 'apt' command/);
  });
  it("REJECTS control chars + an over-long argv", () => {
    expect(validateInstallArgv("apt", ["apt-get", "in\nstall"]).ok).toBe(false);
    expect(validateInstallArgv("apt", Array(70).fill("apt-get")).ok).toBe(false);
    expect(validateInstallArgv("apt", []).ok).toBe(false);
  });
  it("REJECTS a PM token that is a PATH, not a bare name (codex BLOCKER — no /tmp/apt-get)", () => {
    expect(validateInstallArgv("apt", ["sudo", "/tmp/apt-get", "install", "ffmpeg"]).ok).toBe(false);
    expect(validateInstallArgv("apt", ["env", "apt-get", "install"]).ok).toBe(false);
    expect(validateInstallArgv("apt", ["/bin/apt-get", "install"]).ok).toBe(false);
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

describe("candidateNames + multi-candidate resolution (spec 289)", () => {
  it("candidateNames: [key] when no names; the names set when present", () => {
    expect(candidateNames("ffmpeg")).toEqual(["ffmpeg"]);
    expect(candidateNames("chrome", ["google-chrome", "chromium"])).toEqual(["google-chrome", "chromium"]);
    expect(candidateNames("chrome", [])).toEqual(["chrome"]); // empty == omitted
  });

  it("detectExternalTool: first TRUSTED candidate wins (the present alias)", () => {
    // google-chrome absent, chromium present+trusted (/bin/sh stand-in).
    const r = detectExternalTool("chrome", { names: ["google-chrome", "chromium"], install: {}, manual: "x" }, { resolve: (n) => (n === "chromium" ? "/bin/sh" : null) });
    expect(r).toEqual({ present: true, path: "/bin/sh" });
  });

  it("detectExternalTool: a trusted-but-detect-FAILING candidate falls through to the next (codex HIGH)", () => {
    // candidate A (google-chrome) resolves+trusted but its detect fails; B (chromium) trusted + detect passes.
    const r = detectExternalTool(
      "chrome",
      { names: ["google-chrome", "chromium"], detect: ["--version"], install: {}, manual: "x" },
      { resolve: () => "/bin/sh", runDetect: ((calls) => (_argv: string[]) => { calls.n++; return calls.n >= 2; })({ n: 0 }) },
    );
    expect(r.present).toBe(true);
  });

  it("detectExternalTool: all candidates absent → missing, reason lists the candidate set", () => {
    const r = detectExternalTool("chrome", { names: ["google-chrome", "chromium"], install: {}, manual: "x" }, { resolve: () => null });
    expect(r.present).toBe(false);
    if (r.present) return;
    expect(r.reason).toMatch(/candidates: google-chrome, chromium/);
  });

  it("detectExternalToolPresence: honours names + returns the first trusted (spawn-free)", () => {
    const r = detectExternalToolPresence("chrome", { names: ["google-chrome", "chromium"], resolve: (n) => (n === "chromium" ? "/bin/sh" : null) });
    expect(r).toEqual({ present: true, path: "/bin/sh" });
  });

  it("detectExternalToolPresence: skips an untrusted earlier candidate, returns the trusted later one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alias-"));
    try {
      fs.chmodSync(dir, 0o777);
      const fake = path.join(dir, "google-chrome");
      fs.writeFileSync(fake, "#!/bin/sh\n"); fs.chmodSync(fake, 0o755); // resolves but UNtrusted (writable dir)
      const r = detectExternalToolPresence("chrome", { names: ["google-chrome", "chromium"], resolve: (n) => (n === "google-chrome" ? fake : n === "chromium" ? "/bin/sh" : null) });
      expect(r).toEqual({ present: true, path: "/bin/sh" });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("detectExternalToolPresence (spec 287 D3 — spawn-free card check)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-presence-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("present:true with the trusted path, and NEVER runs a detect probe (no runDetect dep exists)", () => {
    const r = detectExternalToolPresence("ffmpeg", { resolve: () => "/bin/sh" });
    expect(r).toEqual({ present: true, path: "/bin/sh" });
  });
  it("present:false when unresolved on the clean PATH", () => {
    expect(detectExternalToolPresence("nope-xyz", { resolve: () => null })).toEqual({ present: false });
  });
  it("present:false (no reason leaked) when resolved but untrusted (writable-dir fake)", () => {
    fs.chmodSync(dir, 0o777);
    const fake = path.join(dir, "ffmpeg");
    fs.writeFileSync(fake, "#!/bin/sh\n"); fs.chmodSync(fake, 0o755);
    expect(detectExternalToolPresence("ffmpeg", { resolve: () => fake })).toEqual({ present: false });
  });
});

describe("resolveOnCleanPathNoSpawn (spec 287 D3 — clean-PATH walk requires X_OK)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-walk-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("SKIPS a regular file on PATH that lacks the executable bit (codex MEDIUM regression)", () => {
    const f = path.join(dir, "ffmpeg");
    fs.writeFileSync(f, "binary\n"); fs.chmodSync(f, 0o644); // present but NON-executable
    expect(resolveOnCleanPathNoSpawn("ffmpeg", [dir])).toBeNull();
  });
  it("RESOLVES (realpath) a regular EXECUTABLE file on PATH", () => {
    const f = path.join(dir, "ffmpeg");
    fs.writeFileSync(f, "#!/bin/sh\n"); fs.chmodSync(f, 0o755);
    expect(resolveOnCleanPathNoSpawn("ffmpeg", [dir])).toBe(fs.realpathSync(f));
  });
  it("returns null when the name is absent from every dir", () => {
    expect(resolveOnCleanPathNoSpawn("nope-xyz", [dir])).toBeNull();
  });
});

describe("adaptLockedInstall (spec 287 D4 — lockfile → assisted-install shape)", () => {
  it("wraps each known-PM argv into { argv } and drops unknown PM keys", () => {
    const adapted = adaptLockedInstall({ apt: ["sudo", "apt-get", "install", "-y", "ffmpeg"], brew: ["brew", "install", "ffmpeg"], bogus: ["x"] });
    expect(adapted).toEqual({ apt: { argv: ["sudo", "apt-get", "install", "-y", "ffmpeg"] }, brew: { argv: ["brew", "install", "ffmpeg"] } });
    expect((adapted as Record<string, unknown>).bogus).toBeUndefined();
  });
  it("drops empty/non-array argv entries", () => {
    expect(adaptLockedInstall({ apt: [], dnf: ["dnf", "install", "ffmpeg"] })).toEqual({ dnf: { argv: ["dnf", "install", "ffmpeg"] } });
  });
  it("the adapted map drives buildAssistedInstall to the SAME normalized argv as the manifest path", () => {
    const resolve = (n: string) => (n === "sudo" ? "/bin/sh" : n === "apt-get" ? "/bin/cat" : null); // trusted stand-ins
    const fromLock = buildAssistedInstall(adaptLockedInstall({ apt: ["sudo", "apt-get", "install", "-y", "ffmpeg"] }), { resolve });
    const fromManifest = buildAssistedInstall({ apt: { argv: ["sudo", "apt-get", "install", "-y", "ffmpeg"] } }, { resolve });
    expect(fromLock).toEqual(fromManifest);
    expect(fromLock).toEqual({ ok: true, pm: "apt", argv: ["/bin/sh", "/bin/cat", "install", "-y", "ffmpeg"] });
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
