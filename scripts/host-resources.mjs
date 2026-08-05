/**
 * ESM twin of src/host/hostResources.ts for plain node scripts (verify-full.mjs).
 * Keep algorithms in sync with the TypeScript module (t-019dac).
 *
 * t-0b7aa7 — the SHAPES matter as much as the algorithms here, and this file gets none of the
 * TypeScript union's protection: `scripts/` is outside tsconfig's include, so nothing stops a
 * caller reading a field the answer should not have. A refused decision therefore carries no
 * `workers` key at all, matching the .ts union. Reading it blind now yields `undefined`, which
 * fails loudly, rather than `0`, which reads as a legitimate size.
 */
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

const DEFAULT_MIN_AVAILABLE_MB = 2048;
const DEFAULT_RESERVE_MB = 3072;
/** t-3ad4af — measured, not estimated: peak 289MB / marginal 215MB per pool worker. See the .ts twin. */
const DEFAULT_WORKER_MB = 320;
const HARD_CAP_WORKERS = 16;

function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export function parseMeminfo(text) {
  const get = (key) => {
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

export function readHostMemory(readFile = (p) => readFileSync(p, "utf8")) {
  try {
    const path = process.env.TACHYON_VERIFY_MEMINFO_PATH || "/proc/meminfo";
    const parsed = parseMeminfo(readFile(path));
    if (parsed) return parsed;
  } catch {
    /* fall through */
  }
  return { memTotalMb: 0, memAvailableMb: 0, swapTotalMb: 0, swapFreeMb: 0, source: "unavailable" };
}

export function recommendVitestMaxWorkers(input) {
  const forced = envInt("TACHYON_VITEST_MAX_WORKERS");
  if (forced !== undefined && forced >= 1) {
    return Math.min(forced, input.hardCap ?? HARD_CAP_WORKERS, Math.max(1, input.cpuCount || 1));
  }
  const cpu = Math.max(1, input.cpuCount || 1);
  const hardCap = input.hardCap ?? HARD_CAP_WORKERS;
  if (input.memory.source === "unavailable") return Math.min(4, cpu, hardCap);
  const reserve = input.reserveMb ?? envInt("TACHYON_VERIFY_RESERVE_MB") ?? DEFAULT_RESERVE_MB;
  const workerMb = Math.max(128, input.workerMb ?? envInt("TACHYON_VERIFY_WORKER_MB") ?? DEFAULT_WORKER_MB);
  const budget = Math.max(0, input.memory.memAvailableMb - reserve);
  const byRam = Math.floor(budget / workerMb);
  return Math.max(1, Math.min(Math.max(byRam, 1), cpu, hardCap));
}

export function decideHeavyGate(input = {}) {
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
    return { ok: true, workers, memory, reason: `meminfo unavailable — conservative workers=${workers}` };
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
