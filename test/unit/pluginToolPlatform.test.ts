import { describe, it, expect } from "vitest";
import { resolvePlatform, type PlatformProbes } from "../../apps/vscode-extension/src/plugins/toolPlatform.js";

/** Build a probe set from a partial override over sane linux-glibc-x64 defaults. */
function probes(over: Partial<PlatformProbes> = {}): PlatformProbes {
  return {
    platform: "linux",
    arch: "x64",
    unameM: () => "x86_64",
    procTranslated: () => false,
    hardwareArm64: () => false,
    glibcVersion: () => "glibc 2.35",
    lddVersion: () => "ldd (GNU libc) 2.35",
    ...over,
  };
}

describe("resolvePlatform", () => {
  it("resolves linux x64 glibc", () => {
    const r = resolvePlatform(probes());
    expect(r).toMatchObject({ ok: true, keys: ["linux-x64-glibc"] });
  });

  it("resolves linux arm64 musl (getconf absent, ldd reports musl on stderr)", () => {
    const r = resolvePlatform(probes({ arch: "arm64", unameM: () => "aarch64", glibcVersion: () => null, lddVersion: () => "musl libc (aarch64)\nVersion 1.2.4" }));
    expect(r).toMatchObject({ ok: true, keys: ["linux-arm64-musl"] });
  });

  it("treats WSL as linux (platform=linux, uname Linux x86_64)", () => {
    const r = resolvePlatform(probes({ unameM: () => "x86_64" }));
    expect(r).toMatchObject({ ok: true, keys: ["linux-x64-glibc"] });
  });

  it("darwin on Apple Silicon prefers arm64, allows x64 fallback", () => {
    const r = resolvePlatform(probes({ platform: "darwin", arch: "arm64", hardwareArm64: () => true, unameM: () => "arm64" }));
    expect(r).toMatchObject({ ok: true, keys: ["darwin-arm64", "darwin-x64"] });
  });

  it("darwin x64 Node under Rosetta STILL prefers native arm64 (hardware is arm64)", () => {
    const r = resolvePlatform(probes({ platform: "darwin", arch: "x64", hardwareArm64: () => true, procTranslated: () => true, unameM: () => "x86_64" }));
    expect(r).toMatchObject({ ok: true, keys: ["darwin-arm64", "darwin-x64"] });
    if (r.ok) expect(r.notes.join(" ")).toMatch(/Rosetta/);
  });

  it("resolves an Intel Mac to darwin-x64", () => {
    const r = resolvePlatform(probes({ platform: "darwin", arch: "x64", hardwareArm64: () => false, unameM: () => "x86_64" }));
    expect(r).toMatchObject({ ok: true, keys: ["darwin-x64"] });
  });

  it("rejects Windows (UNSUPPORTED_OS)", () => {
    expect(resolvePlatform(probes({ platform: "win32" }))).toMatchObject({ ok: false, code: "UNSUPPORTED_OS" });
  });

  it("fails closed when libc is unresolvable (no getconf, BusyBox ldd)", () => {
    const r = resolvePlatform(probes({ glibcVersion: () => null, lddVersion: () => null }));
    expect(r).toMatchObject({ ok: false, code: "LIBC_UNRESOLVED" });
  });

  it("fails AMBIGUOUS_ARCH when process.arch disagrees with uname -m (linux)", () => {
    const r = resolvePlatform(probes({ arch: "x64", unameM: () => "aarch64" }));
    expect(r).toMatchObject({ ok: false, code: "AMBIGUOUS_ARCH" });
  });

  it("trusts process.arch when uname -m is unavailable (and records a note)", () => {
    const r = resolvePlatform(probes({ unameM: () => null }));
    expect(r).toMatchObject({ ok: true, keys: ["linux-x64-glibc"] });
    if (r.ok) expect(r.notes.join(" ")).toMatch(/uname -m unavailable/);
  });

  it("rejects an unsupported arch (linux riscv64)", () => {
    const r = resolvePlatform(probes({ arch: "riscv64", unameM: () => "riscv64", glibcVersion: () => "glibc 2.35" }));
    expect(r).toMatchObject({ ok: false, code: "UNSUPPORTED_ARCH" });
  });
});
