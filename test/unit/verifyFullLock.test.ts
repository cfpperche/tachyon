import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The production runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- importing the owned .mjs runner directly is the behavior under test.
import { acquireVerifyFullLock, awaitVerifyFullLock, resolveHeavyGate } from "../../scripts/verify-full.mjs";
import hostResourceCostInputs from "@tachyon/shared/host-resource-cost-inputs.cjs";

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
    // Read, not restated: the cap's VALUE is pinned once in hostResources.test.ts (t-fb7025). A
    // literal here would silently stop bounding anything the day the cap moved.
    expect(gate.workers).toBeLessThanOrEqual(hostResourceCostInputs.HARD_CAP_WORKERS);
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

describe("the gate QUEUES instead of refusing (t-fb7025)", () => {
  const locks: string[] = [];
  afterEach(() => {
    for (const lock of locks.splice(0)) {
      try { fs.unlinkSync(lock); } catch { /* released by the test */ }
    }
  });

  /**
   * Measured before changing anything: across 141 runs the gate never overlapped and sat idle ~90% of
   * the day, so contention is not the cost. What hurts is BURSTS — 41% of runs start within two
   * minutes of the previous, 20 within fifteen seconds. Refusing pushed that queue onto every caller,
   * which is how a 78s command grew a monitor-and-retry ritual around it.
   *
   * The one-at-a-time limit is untouched, and must stay: t-6a9bc4 bought it with a proven outage.
   * `acquireVerifyFullLock` still refuses — these assert the WAITER built on top of it.
   */
  it("waits for a live holder and acquires when it releases, rather than failing", async () => {
    const lockPath = path.join(os.tmpdir(), `tachyon-verify-full-wait-${process.pid}-${Date.now()}.lock`);
    locks.push(lockPath);
    const held = acquireVerifyFullLock(lockPath);
    let announced = 0;

    const pending = awaitVerifyFullLock(lockPath, { pollMs: 5, timeoutMs: 5_000, onWait: () => { announced += 1; } });
    setTimeout(() => held.release(), 40);
    const acquired = await pending;

    expect(acquired.waitedMs, "acquired without ever waiting — the holder was still live").toBeGreaterThan(0);
    expect(announced, "the wait must be announced exactly once, not once per poll").toBe(1);
    acquired.release();
  });

  it("gives up at a deadline instead of hanging forever on a stuck holder", async () => {
    // A wait with no bound turns a hung gate into a command that never returns, which is worse than
    // the refusal it replaced: nobody can read a process that is simply gone quiet.
    const lockPath = path.join(os.tmpdir(), `tachyon-verify-full-deadline-${process.pid}-${Date.now()}.lock`);
    locks.push(lockPath);
    const held = acquireVerifyFullLock(lockPath);

    await expect(awaitVerifyFullLock(lockPath, { pollMs: 5, timeoutMs: 30 }))
      .rejects.toThrow(/already running/);
    held.release();
  });

  it("takes a free lock immediately, with no wait announced", async () => {
    const lockPath = path.join(os.tmpdir(), `tachyon-verify-full-free-${process.pid}-${Date.now()}.lock`);
    locks.push(lockPath);
    let announced = 0;

    const acquired = await awaitVerifyFullLock(lockPath, { pollMs: 5, onWait: () => { announced += 1; } });

    expect(announced, "announced a queue that never happened").toBe(0);
    acquired.release();
  });
});
