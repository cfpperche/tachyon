/**
 * spec 265 task 2 — platform RESOLUTION for tool provisioning (task-0 gate (d)).
 *
 * Map the running host to the explicit, libc-qualified platform key(s) a `tools` pin targets
 * (see manifest `TOOL_PLATFORM_KEYS`). v1 = linux/macOS only (Windows excluded).
 *
 * Returns a best-first PREFERENCE LIST of keys, not a single key, so the caller (the tool plan)
 * can apply the "prefer native, fall back only if unpinned" rule WITHOUT this resolver needing to
 * see the manifest's available pins:
 *   - darwin on arm64 hardware → ["darwin-arm64", "darwin-x64"]  (native preferred; Rosetta x64 fallback)
 *   - darwin on x64 hardware   → ["darwin-x64"]
 *   - linux                    → ["linux-<arch>-<libc>"]          (single — glibc/musl/arch are NOT interchangeable)
 *
 * Precedence (gate (d)):
 *  1. OS: process.platform; win32 → UNSUPPORTED_OS; non-{linux,darwin} → UNSUPPORTED_OS. WSL reports `linux`.
 *  2. Arch = the TARGET binary's ABI, not blindly the Node ABI:
 *       - darwin: HARDWARE arch via `sysctl hw.optional.arm64` (+ proc_translated note) — an x64 Node under
 *         Rosetta on arm64 hardware still prefers native darwin-arm64.
 *       - linux: process.arch corroborated by `uname -m`; DISAGREEMENT → AMBIGUOUS_ARCH (never guess).
 *  3. libc (linux): `getconf GNU_LIBC_VERSION` → glibc; else `ldd --version` (GNU banner → glibc, "musl" → musl);
 *     unresolved (BusyBox ldd / missing getconf) → LIBC_UNRESOLVED. A fully-static binary needs DUAL pins.
 *
 * The pure core `resolvePlatform(probes)` is injectable for tests; `resolveHostPlatform()` wires the default
 * (sync, child_process) probes and memoizes the result.
 */

import { execFileSync } from "node:child_process";
import type { ToolPlatformKey } from "./manifest.js";

export type UnsupportedCode = "UNSUPPORTED_OS" | "UNSUPPORTED_ARCH" | "AMBIGUOUS_ARCH" | "LIBC_UNRESOLVED";

export interface ResolvedPlatform {
  ok: true;
  /** acceptable platform keys, best-first (the caller picks the first the manifest actually pins). */
  keys: ToolPlatformKey[];
  /** human-readable resolution notes (Rosetta, an unavailable probe) — surfaced at consent, never blocking. */
  notes: string[];
}

export interface UnsupportedPlatform {
  ok: false;
  code: UnsupportedCode;
  detail: string;
}

export type PlatformResolution = ResolvedPlatform | UnsupportedPlatform;

/** The host facts the resolver consumes. Injectable so the resolution logic is testable without a real host. */
export interface PlatformProbes {
  platform: NodeJS.Platform; // process.platform
  arch: string; // process.arch
  /** `uname -m` (x86_64 / aarch64 / arm64 / …) or null when unavailable. */
  unameM(): string | null;
  /** darwin: `sysctl -n sysctl.proc_translated` === "1" (THIS process is Rosetta-translated). */
  procTranslated(): boolean;
  /** darwin: `sysctl -n hw.optional.arm64` === "1" (the HARDWARE is Apple Silicon, regardless of translation). */
  hardwareArm64(): boolean;
  /** linux: `getconf GNU_LIBC_VERSION` output (non-empty → glibc) or null. */
  glibcVersion(): string | null;
  /** linux: `ldd --version` banner (stdout OR stderr — musl prints to stderr + exits 1) or null. */
  lddVersion(): string | null;
}

function unsup(code: UnsupportedCode, detail: string): UnsupportedPlatform {
  return { ok: false, code, detail };
}

/** Normalize a Node arch + a `uname -m` into "x64" | "arm64" | "other:<raw>" | "ambiguous". */
function normalizeArch(nodeArch: string, unameM: string | null, notes: string[]): "x64" | "arm64" | "ambiguous" | string {
  const fromNode = nodeArch === "x64" ? "x64" : nodeArch === "arm64" ? "arm64" : `other:${nodeArch}`;
  if (unameM === null) {
    notes.push("uname -m unavailable — trusting process.arch");
    return fromNode;
  }
  const m = unameM.trim().toLowerCase();
  const fromUname = m === "x86_64" || m === "amd64" ? "x64" : m === "aarch64" || m === "arm64" ? "arm64" : `other:${m}`;
  if (fromNode === fromUname) return fromNode;
  notes.push(`process.arch '${nodeArch}' disagrees with uname -m '${unameM}'`);
  return "ambiguous";
}

/** Resolve linux libc: glibc | musl | null (unresolved). */
function resolveLibc(probes: PlatformProbes, notes: string[]): "glibc" | "musl" | null {
  const g = probes.glibcVersion();
  if (g && /glibc|GNU/i.test(g)) {
    notes.push(`glibc detected (${g.trim().split(/\s+/).slice(0, 2).join(" ")})`);
    return "glibc";
  }
  const ldd = probes.lddVersion();
  if (ldd) {
    if (/musl/i.test(ldd)) {
      notes.push("musl libc detected (ldd)");
      return "musl";
    }
    if (/glibc|GNU libc|GLIBC/i.test(ldd)) {
      notes.push("glibc detected (ldd)");
      return "glibc";
    }
  }
  return null;
}

/**
 * Pure platform resolution from injected probes. Never throws.
 */
export function resolvePlatform(probes: PlatformProbes): PlatformResolution {
  const notes: string[] = [];
  const p = probes.platform;

  if (p === "win32") return unsup("UNSUPPORTED_OS", "Windows is not supported in v1 (linux/wsl/macOS only)");
  if (p !== "linux" && p !== "darwin") return unsup("UNSUPPORTED_OS", `unsupported OS '${p}' (v1 = linux/wsl/macOS)`);

  if (p === "darwin") {
    if (probes.procTranslated()) notes.push("running under Rosetta translation (x64 Node on arm64 hardware)");
    if (probes.hardwareArm64()) {
      // Apple Silicon: prefer a native arm64 tool; a translated x64 tool is the fallback only when unpinned.
      return { ok: true, keys: ["darwin-arm64", "darwin-x64"], notes };
    }
    // Intel Mac: corroborate arch (no translation in play).
    const arch = normalizeArch(probes.arch, probes.unameM(), notes);
    if (arch === "ambiguous") return unsup("AMBIGUOUS_ARCH", "darwin: process.arch disagrees with uname -m");
    if (arch !== "x64") return unsup("UNSUPPORTED_ARCH", `darwin arch '${arch}' is not supported (expected x64/arm64)`);
    return { ok: true, keys: ["darwin-x64"], notes };
  }

  // linux (incl. WSL)
  const arch = normalizeArch(probes.arch, probes.unameM(), notes);
  if (arch === "ambiguous") return unsup("AMBIGUOUS_ARCH", "linux: process.arch disagrees with uname -m");
  if (arch !== "x64" && arch !== "arm64") return unsup("UNSUPPORTED_ARCH", `linux arch '${arch}' is not supported (expected x64/arm64)`);
  const libc = resolveLibc(probes, notes);
  if (!libc) return unsup("LIBC_UNRESOLVED", "could not determine glibc vs musl (getconf/ldd unavailable or unrecognized); a fully-static tool must pin BOTH -glibc and -musl");
  return { ok: true, keys: [`linux-${arch}-${libc}` as ToolPlatformKey], notes };
}

/** Run a command capturing stdout, returning trimmed output or null on any failure. */
function tryExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The default host probes (sync child_process). `ldd --version` captures stderr too (musl writes there + exits 1). */
export function defaultProbes(): PlatformProbes {
  return {
    platform: process.platform,
    arch: process.arch,
    unameM: () => tryExec("uname", ["-m"]),
    procTranslated: () => tryExec("sysctl", ["-n", "sysctl.proc_translated"]) === "1",
    hardwareArm64: () => tryExec("sysctl", ["-n", "hw.optional.arm64"]) === "1",
    glibcVersion: () => tryExec("getconf", ["GNU_LIBC_VERSION"]),
    lddVersion: () => {
      try {
        return execFileSync("ldd", ["--version"], { encoding: "utf8", timeout: 5000 }).trim() || null;
      } catch (e) {
        // musl ldd: prints the banner to stderr and exits non-zero.
        const err = e as { stderr?: Buffer | string; stdout?: Buffer | string };
        const s = `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}`.trim();
        return s || null;
      }
    },
  };
}

let cached: PlatformResolution | undefined;

/** Resolve the running host's platform (memoized). Wires `defaultProbes()` into the pure core. */
export function resolveHostPlatform(): PlatformResolution {
  if (cached === undefined) cached = resolvePlatform(defaultProbes());
  return cached;
}

/** Test-only: clear the memoized host resolution. */
export function _resetHostPlatformCache(): void {
  cached = undefined;
}
