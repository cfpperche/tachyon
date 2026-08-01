import { afterEach, describe, expect, it } from "vitest";
import {
  decideHeavyGate,
  parseMeminfo,
  recommendVitestMaxWorkers,
  type HostMemorySnapshot,
} from "../../src/host/hostResources.js";

const SAMPLE = `
MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
SwapTotal:       4194304 kB
SwapFree:        3145728 kB
`.trim();

describe("hostResources (t-019dac)", () => {
  const prev: Record<string, string | undefined> = {};
  const keys = [
    "TACHYON_VITEST_MAX_WORKERS",
    "TACHYON_VERIFY_MIN_AVAILABLE_MB",
    "TACHYON_VERIFY_RESERVE_MB",
    "TACHYON_VERIFY_WORKER_MB",
    "TACHYON_VERIFY_REQUIRE_MEMINFO",
  ];
  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
      delete prev[k];
    }
  });
  function pin(env: Record<string, string>) {
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
  }

  it("parses /proc/meminfo into MiB", () => {
    const m = parseMeminfo(SAMPLE)!;
    expect(m.source).toBe("proc-meminfo");
    expect(m.memTotalMb).toBe(16000);
    expect(m.memAvailableMb).toBe(8000);
    expect(m.swapFreeMb).toBe(3072);
  });

  it("auto-sizes workers higher when more RAM is free", () => {
    const low: HostMemorySnapshot = {
      memTotalMb: 8000,
      memAvailableMb: 3500,
      swapTotalMb: 0,
      swapFreeMb: 0,
      source: "proc-meminfo",
    };
    const high: HostMemorySnapshot = {
      memTotalMb: 64000,
      memAvailableMb: 48000,
      swapTotalMb: 0,
      swapFreeMb: 0,
      source: "proc-meminfo",
    };
    pin({ TACHYON_VERIFY_RESERVE_MB: "3072", TACHYON_VERIFY_WORKER_MB: "768" });
    const wLow = recommendVitestMaxWorkers({ memory: low, cpuCount: 24 });
    const wHigh = recommendVitestMaxWorkers({ memory: high, cpuCount: 24 });
    expect(wLow).toBeGreaterThanOrEqual(1);
    expect(wHigh).toBeGreaterThan(wLow);
    expect(wHigh).toBeLessThanOrEqual(16);
  });

  it("refuses heavy gate under memory pressure", () => {
    pin({ TACHYON_VERIFY_MIN_AVAILABLE_MB: "4096" });
    const decision = decideHeavyGate({
      memory: {
        memTotalMb: 16000,
        memAvailableMb: 1500,
        swapTotalMb: 4000,
        swapFreeMb: 100,
        source: "proc-meminfo",
      },
      cpuCount: 8,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("MEMORY_PRESSURE");
      expect(decision.reason).toMatch(/memory pressure/i);
    }
    // t-0b7aa7 — a refusal carries no worker count. The union enforces this for TypeScript callers,
    // but the ESM twin in scripts/ gets no such help, so pin the runtime shape the twins share.
    expect("workers" in decision).toBe(false);
  });

  it("allows gate and reports auto workers when free RAM is healthy", () => {
    pin({ TACHYON_VERIFY_MIN_AVAILABLE_MB: "2048", TACHYON_VERIFY_RESERVE_MB: "3072", TACHYON_VERIFY_WORKER_MB: "768" });
    const decision = decideHeavyGate({
      memory: {
        memTotalMb: 32000,
        memAvailableMb: 16000,
        swapTotalMb: 0,
        swapFreeMb: 0,
        source: "proc-meminfo",
      },
      cpuCount: 8,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.workers).toBeGreaterThanOrEqual(1);
      expect(decision.workers).toBeLessThanOrEqual(8);
      expect(decision.reason).toMatch(/auto-sized/);
    }
  });

  it("honors TACHYON_VITEST_MAX_WORKERS force override", () => {
    pin({ TACHYON_VITEST_MAX_WORKERS: "2" });
    const w = recommendVitestMaxWorkers({
      memory: {
        memTotalMb: 64000,
        memAvailableMb: 50000,
        swapTotalMb: 0,
        swapFreeMb: 0,
        source: "proc-meminfo",
      },
      cpuCount: 24,
    });
    expect(w).toBe(2);
  });
});
