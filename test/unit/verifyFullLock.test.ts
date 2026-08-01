import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The production runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- importing the owned .mjs runner directly is the behavior under test.
import { acquireVerifyFullLock, resolveHeavyGate } from "../../scripts/verify-full.mjs";

/**
 * t-0b7aa7 — these used to read `VITEST_MAX_WORKERS`, a bare number resolved at import time from
 * the real /proc/meminfo, and assert `>= 1` without ever asking whether the gate had said yes.
 * On a host under memory pressure the gate refuses and sizes nothing, so the assertion failed with
 * `expected 0 to be greater than or equal to 1` — verify:full going red because a test measured a
 * refusal as though it were a measurement, on the exact machines where the gate matters most.
 *
 * The sizing intent ("never nproc-blind; hard-capped") is only meaningful for an `ok` decision, so
 * the test now PINS the memory it wants through the seam hostResources documents for this purpose
 * and exercises both shapes. Nothing here depends on how much RAM the host happens to have.
 */
const MEMINFO_KNOBS = [
  "TACHYON_VERIFY_MEMINFO_PATH",
  "TACHYON_VITEST_MAX_WORKERS",
  "TACHYON_VERIFY_MIN_AVAILABLE_MB",
  "TACHYON_VERIFY_RESERVE_MB",
  "TACHYON_VERIFY_WORKER_MB",
  "TACHYON_VERIFY_REQUIRE_MEMINFO",
] as const;

function meminfo(availableMb: number): string {
  return [
    `MemTotal:       ${64 * 1024 * 1024} kB`,
    `MemFree:        ${availableMb * 1024} kB`,
    `MemAvailable:   ${availableMb * 1024} kB`,
    "SwapTotal:       4194304 kB",
    "SwapFree:        1048576 kB",
  ].join("\n");
}

describe("verify-full control-plane protection (t-6a9bc4 slice-1)", () => {
  const locks: string[] = [];
  const files: string[] = [];
  const prevEnv: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const p of [...locks, ...files]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    locks.length = 0;
    files.length = 0;
    for (const k of MEMINFO_KNOBS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
      delete prevEnv[k];
    }
  });

  /** Pin the host memory the gate will read, and neutralize every other knob that could steer it. */
  function pinHostMemory(availableMb: number, extra: Record<string, string> = {}) {
    const file = path.join(os.tmpdir(), `tachyon-meminfo-${process.pid}-${Date.now()}-${availableMb}`);
    fs.writeFileSync(file, meminfo(availableMb), { mode: 0o600 });
    files.push(file);
    const env: Record<string, string | undefined> = {
      TACHYON_VERIFY_MEMINFO_PATH: file,
      TACHYON_VITEST_MAX_WORKERS: undefined,
      TACHYON_VERIFY_REQUIRE_MEMINFO: undefined,
      TACHYON_VERIFY_MIN_AVAILABLE_MB: "2048",
      TACHYON_VERIFY_RESERVE_MB: "3072",
      TACHYON_VERIFY_WORKER_MB: "768",
      ...extra,
    };
    for (const [k, v] of Object.entries(env)) {
      prevEnv[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("auto-sizes vitest workers when the gate allows (never nproc-blind; hard-capped)", () => {
    pinHostMemory(32_000);
    const gate = resolveHeavyGate();
    expect(gate.ok).toBe(true);
    expect(gate.workers).toBeGreaterThanOrEqual(1);
    expect(gate.workers).toBeLessThanOrEqual(16);
    expect(gate.workers).toBeLessThanOrEqual(os.cpus().length || 1);
    expect(gate.reason).toMatch(/auto-sized/);
  });

  it("refuses under memory pressure, and the refusal sizes nothing at all", () => {
    pinHostMemory(1_000);
    const gate = resolveHeavyGate();
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe("MEMORY_PRESSURE");
    expect(gate.reason).toMatch(/memory pressure/i);
    expect(gate.memory.memAvailableMb).toBe(1_000);
    // The regression guard for t-0b7aa7. `workers: 0` on a refusal is what let a caller read a
    // decision that declined to run as a decision to run with zero workers. A refusal must not
    // answer the sizing question at all, so re-adding the field fails here.
    expect("workers" in gate).toBe(false);
  });

  it("refuses when meminfo is unreadable and required, and that refusal sizes nothing either", () => {
    pinHostMemory(32_000, {
      TACHYON_VERIFY_MEMINFO_PATH: path.join(os.tmpdir(), `tachyon-meminfo-absent-${process.pid}-${Date.now()}`),
      TACHYON_VERIFY_REQUIRE_MEMINFO: "1",
    });
    const gate = resolveHeavyGate();
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe("MEMORY_UNAVAILABLE");
    expect("workers" in gate).toBe(false);
  });

  it("refuses a second concurrent full-suite gate while the holder is alive", () => {
    const lockPath = path.join(os.tmpdir(), `tachyon-verify-full-test-${process.pid}-${Date.now()}.lock`);
    locks.push(lockPath);
    const first = acquireVerifyFullLock(lockPath);
    expect(() => acquireVerifyFullLock(lockPath)).toThrow(/VERIFY_FULL_BUSY|already running/);
    first.release();
    const second = acquireVerifyFullLock(lockPath);
    second.release();
  });

  it("steals a stale lock when the holder pid is dead", () => {
    const lockPath = path.join(os.tmpdir(), `tachyon-verify-full-stale-${process.pid}-${Date.now()}.lock`);
    locks.push(lockPath);
    // PID 1 is init — may be alive. Use an impossibly high dead pid instead.
    fs.writeFileSync(lockPath, "999999991\n", { mode: 0o600 });
    const stolen = acquireVerifyFullLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    stolen.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
