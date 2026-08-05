import { readFileSync } from "node:fs";
import { cpus } from "node:os";

/**
 * t-019dac — host memory awareness for heavy gates (verify:full / verify_task full).
 * Auto-size vitest workers from free RAM; fail-closed under pressure.
 *
 * Env overrides:
 *   TACHYON_VITEST_MAX_WORKERS          force worker count
 *   TACHYON_VERIFY_MIN_AVAILABLE_MB     refuse below this free RAM (default 2048)
 *   TACHYON_VERIFY_RESERVE_MB           keep for control plane (default 3072)
 *   TACHYON_VERIFY_WORKER_MB            assumed cost per vitest worker (default 768)
 *   TACHYON_VERIFY_MEMINFO_PATH         override /proc/meminfo (tests)
 *   TACHYON_VERIFY_REQUIRE_MEMINFO=1    refuse when meminfo unreadable
 */

export type HostMemorySnapshot = {
  memTotalMb: number;
  memAvailableMb: number;
  swapTotalMb: number;
  swapFreeMb: number;
  source: "proc-meminfo" | "unavailable";
};

/**
 * t-0b7aa7 — a REFUSAL carries no worker count, on purpose.
 *
 * This union used to put `workers: 0` on the `ok: false` branch, which made `workers` present on
 * both branches and therefore readable as a plain `number` without ever consulting `ok`. Zero was
 * the honest value for "not running" and exactly the wrong SHAPE: a refusal that answers a sizing
 * question at all will eventually be read as a size. Dropping the field makes the compiler refuse
 * `decision.workers` until the caller has narrowed on `ok`, so the mistake is a type error instead
 * of a number that travels.
 */
export type HeavyGateDecision =
  | { ok: true; workers: number; memory: HostMemorySnapshot; reason: string }
  | { ok: false; code: "MEMORY_PRESSURE" | "MEMORY_UNAVAILABLE"; memory: HostMemorySnapshot; reason: string };

const DEFAULT_MIN_AVAILABLE_MB = 2048;
const DEFAULT_RESERVE_MB = 3072;
/**
 * t-3ad4af — 768 was an estimate and it was wrong by ~2.7x. Sampling PSS per process across the full
 * `test/unit` suite, a single pool worker never exceeded 289MB and the marginal cost of adding one
 * was 215MB. The estimate mattered: it is the divisor of the whole budget, so the sizer was wrong at
 * the source. The rest of a run's cost is not per-worker at all — see `vitestBudget.ts`, which owns
 * the fixed per-invocation term this file never modelled.
 */
const DEFAULT_WORKER_MB = 320;
const HARD_CAP_WORKERS = 16;

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Parse Linux /proc/meminfo kB fields into MiB. */
export function parseMeminfo(text: string): HostMemorySnapshot | undefined {
  const get = (key: string): number | undefined => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
    if (!m) return undefined;
    return Math.floor(Number(m[1]) / 1024);
  };
  const memTotalMb = get("MemTotal");
  const memAvailableMb = get("MemAvailable") ?? get("MemFree");
  if (memTotalMb === undefined || memAvailableMb === undefined) return undefined;
  return {
    memTotalMb,
    memAvailableMb,
    swapTotalMb: get("SwapTotal") ?? 0,
    swapFreeMb: get("SwapFree") ?? 0,
    source: "proc-meminfo",
  };
}

export function readHostMemory(readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): HostMemorySnapshot {
  try {
    const path = process.env.TACHYON_VERIFY_MEMINFO_PATH || "/proc/meminfo";
    const parsed = parseMeminfo(readFile(path));
    if (parsed) return parsed;
  } catch {
    /* fall through */
  }
  return { memTotalMb: 0, memAvailableMb: 0, swapTotalMb: 0, swapFreeMb: 0, source: "unavailable" };
}

/**
 * Auto-size vitest workers from available RAM (minus control-plane reserve).
 * Scales up when the machine has more free memory (e.g. user upgrades RAM).
 */
export function recommendVitestMaxWorkers(input: {
  memory: HostMemorySnapshot;
  cpuCount: number;
  reserveMb?: number;
  workerMb?: number;
  hardCap?: number;
}): number {
  const forced = envInt("TACHYON_VITEST_MAX_WORKERS");
  if (forced !== undefined && forced >= 1) {
    return Math.min(forced, input.hardCap ?? HARD_CAP_WORKERS, Math.max(1, input.cpuCount || 1));
  }
  const cpu = Math.max(1, input.cpuCount || 1);
  const hardCap = input.hardCap ?? HARD_CAP_WORKERS;
  if (input.memory.source === "unavailable") {
    return Math.min(4, cpu, hardCap);
  }
  const reserve = input.reserveMb ?? envInt("TACHYON_VERIFY_RESERVE_MB") ?? DEFAULT_RESERVE_MB;
  const workerMb = Math.max(128, input.workerMb ?? envInt("TACHYON_VERIFY_WORKER_MB") ?? DEFAULT_WORKER_MB);
  const budget = Math.max(0, input.memory.memAvailableMb - reserve);
  const byRam = Math.floor(budget / workerMb);
  return Math.max(1, Math.min(Math.max(byRam, 1), cpu, hardCap));
}

/** Fail-closed gate for heavy work (full suite / verify_task full). */
export function decideHeavyGate(input: {
  memory?: HostMemorySnapshot;
  cpuCount?: number;
  minAvailableMb?: number;
} = {}): HeavyGateDecision {
  const memory = input.memory ?? readHostMemory();
  const cpuCount = input.cpuCount ?? (cpus().length || 1);
  const minAvailable = input.minAvailableMb ?? envInt("TACHYON_VERIFY_MIN_AVAILABLE_MB") ?? DEFAULT_MIN_AVAILABLE_MB;

  if (memory.source === "unavailable") {
    if (process.env.TACHYON_VERIFY_REQUIRE_MEMINFO === "1") {
      return {
        ok: false,
        code: "MEMORY_UNAVAILABLE",
        memory,
        reason: "heavy gate refused: host meminfo unavailable (TACHYON_VERIFY_REQUIRE_MEMINFO=1)",
      };
    }
    const workers = recommendVitestMaxWorkers({ memory, cpuCount });
    return {
      ok: true,
      workers,
      memory,
      reason: `meminfo unavailable — conservative workers=${workers}`,
    };
  }

  if (memory.memAvailableMb < minAvailable) {
    return {
      ok: false,
      code: "MEMORY_PRESSURE",
      memory,
      reason:
        `heavy gate refused: memory pressure (MemAvailable ${memory.memAvailableMb}MB < min ${minAvailable}MB; ` +
        `total ${memory.memTotalMb}MB, swapFree ${memory.swapFreeMb}MB). ` +
        `t-019dac control-plane protection — free RAM or lower TACHYON_VERIFY_MIN_AVAILABLE_MB.`,
    };
  }

  const workers = recommendVitestMaxWorkers({ memory, cpuCount });
  return {
    ok: true,
    workers,
    memory,
    reason:
      `ok: MemAvailable ${memory.memAvailableMb}MB / total ${memory.memTotalMb}MB → workers=${workers} ` +
      `(auto-sized; grows with free RAM)`,
  };
}

export function formatHeavyGateRefusal(decision: Extract<HeavyGateDecision, { ok: false }>): string {
  return decision.reason;
}
