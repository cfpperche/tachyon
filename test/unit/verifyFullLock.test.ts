import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The production runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- importing the owned .mjs runner directly is the behavior under test.
import { acquireVerifyFullLock, VITEST_MAX_WORKERS } from "../../scripts/verify-full.mjs";

describe("verify-full control-plane protection (t-6a9bc4 slice-1)", () => {
  const locks: string[] = [];
  afterEach(() => {
    for (const p of locks) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    locks.length = 0;
  });

  it("caps vitest workers well below nproc", () => {
    expect(VITEST_MAX_WORKERS).toBeGreaterThanOrEqual(1);
    expect(VITEST_MAX_WORKERS).toBeLessThanOrEqual(4);
    expect(VITEST_MAX_WORKERS).toBeLessThanOrEqual(os.cpus().length || 1);
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
