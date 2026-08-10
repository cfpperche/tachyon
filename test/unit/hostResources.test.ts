import { afterEach, describe, expect, it } from "vitest";
import {
  decideHeavyGate,
  parseMeminfo,
  readHostMemory,
  recommendVitestMaxWorkers,
  type HostMemorySnapshot,
} from "../../src/host/hostResources.js";
import hostResourceSizing from "../../shared/host-resource-sizing.cjs";
import hostResourceCostInputs from "../../shared/host-resource-cost-inputs.cjs";

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
    expect(wHigh).toBeLessThanOrEqual(hostResourceCostInputs.HARD_CAP_WORKERS);
  });

  /**
   * t-fb7025 — the ONE place the cap's VALUE is pinned. Everywhere else asserts against the
   * imported constant, which proves the plumbing applies it but could never notice the number
   * changing; this literal is what makes a change to it a decision somebody has to defend.
   *
   * The number is a measurement, not a preference. Two runs of `verify:full` on the same tree,
   * 2026-08-09, 24 logical CPUs / 16GB: 15 workers → 91s wall and load1 peak 16.67; 8 workers → 88s
   * wall and load1 peak 8.63. The suite is 392s of CPU whose longest single file is 55s, so the
   * makespan is max(392/W, 55) and flattens at ~7 workers — everything above the knee is load the
   * human sharing this machine pays for and wall-clock nobody gets back.
   * Full evidence: docs/research/t-fb7025-gate-cost.md.
   *
   * t-392418 — the pinned value is now 6, the conservative side of that same knee. t-91379d
   * re-measured serially on 2026-08-10: 716 files sum to 247s and `engineSupervisor.test.ts` alone
   * is 50s, so at 6 workers the other 715 finish in ~41s — under the 50s floor one file imposes.
   * Both measurements describe the same curve; they differ only in where each stopped descending.
   * The owner chose 6 to calibrate by running the day's work, so expect this literal to move again.
   */
  it("pins the worker cap at the measured CPU knee, and the cap really binds (t-fb7025, t-392418)", () => {
    expect(hostResourceCostInputs.HARD_CAP_WORKERS).toBe(6);

    // Not merely a constant: a machine with RAM and CPUs to spare must still stop at it, through
    // the door every vitest invocation actually uses.
    // Hermetic about its own inputs: `recommendVitestMaxWorkers` honours
    // `TACHYON_VITEST_MAX_WORKERS`, so an operator running the suite with the documented override
    // set would otherwise make this assert their number instead of the cap. Emptying it is what
    // `envInt` reads as absent. (That coupling is a real defect on its own — t-325fe6 — and this
    // line does not fix it; it only stops this test from inheriting it.)
    pin({ TACHYON_VITEST_MAX_WORKERS: "", TACHYON_VERIFY_RESERVE_MB: "3072", TACHYON_VERIFY_WORKER_MB: "320" });
    const roomy: HostMemorySnapshot = {
      memTotalMb: 64_000,
      memAvailableMb: 48_000,
      swapTotalMb: 0,
      swapFreeMb: 0,
      source: "proc-meminfo",
    };
    expect(recommendVitestMaxWorkers({ memory: roomy, cpuCount: 24 })).toBe(6);
    const gate = decideHeavyGate({ memory: roomy, cpuCount: 24 });
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.workers).toBe(6);
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

  /**
   * t-da6b78 — ONE implementation, asserted by identity rather than by reading source.
   *
   * The defect this closes was two copies of the same algorithm kept in step by human memory: this
   * module and an ESM twin at `scripts/host-resources.mjs`, the latter outside tsconfig's include
   * and therefore unprotected — which is how t-0b7aa7 shipped. A grep for the symbol names proves
   * only what the text says today; comparing function IDENTITY proves the extension host and
   * `scripts/verify-full.mjs` are calling the same closure. Re-declaring any of these locally in
   * `hostResources.ts` — the exact regression — breaks this, because a copy is never `===` the
   * original however faithfully it is transcribed.
   */
  it("re-exports the shared sizing module rather than re-implementing it", () => {
    expect(parseMeminfo).toBe(hostResourceSizing.parseMeminfo);
    expect(readHostMemory).toBe(hostResourceSizing.readHostMemory);
    expect(recommendVitestMaxWorkers).toBe(hostResourceSizing.recommendVitestMaxWorkers);
    expect(decideHeavyGate).toBe(hostResourceSizing.decideHeavyGate);
  });

  /**
   * t-0b7aa7 at the SHARED door. The TypeScript union already refuses `decision.workers` before a
   * caller narrows on `ok`, but `scripts/verify-full.mjs` is plain node and gets none of that: for
   * it, the absent key IS the protection — a blind read yields `undefined`, which fails loudly,
   * instead of `0`, which passes for a legitimate size. So pin the runtime shape where both
   * consumers actually read it, not only through the typed re-export.
   */
  it("a refusal from the shared module carries no worker count on either refusal path", () => {
    const pressure = hostResourceSizing.decideHeavyGate({
      memory: { memTotalMb: 16000, memAvailableMb: 100, swapTotalMb: 0, swapFreeMb: 0, source: "proc-meminfo" },
      cpuCount: 8,
      minAvailableMb: 2048,
    });
    expect(pressure.ok).toBe(false);
    expect("workers" in pressure).toBe(false);

    pin({ TACHYON_VERIFY_REQUIRE_MEMINFO: "1" });
    const unavailable = hostResourceSizing.decideHeavyGate({
      memory: { memTotalMb: 0, memAvailableMb: 0, swapTotalMb: 0, swapFreeMb: 0, source: "unavailable" },
      cpuCount: 8,
    });
    expect(unavailable.ok).toBe(false);
    expect("workers" in unavailable).toBe(false);
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
