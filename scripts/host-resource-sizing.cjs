const { cpus } = require("node:os");
const hostMemory = require("../packages/shared/host-memory.cjs");
const {
  DEFAULT_RESERVE_MB,
  DEFAULT_WORKER_MB,
  HARD_CAP_WORKERS,
  envInt,
} = require("../packages/shared/host-resource-cost-inputs.cjs");

const DEFAULT_MIN_AVAILABLE_MB = 2048;

function recommendVitestMaxWorkers(input) {
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

function decideHeavyGate(input = {}) {
  const memory = input.memory ?? hostMemory.readHostMemory(
    undefined,
    process.env.TACHYON_VERIFY_MEMINFO_PATH || "/proc/meminfo",
  );
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

function formatHeavyGateRefusal(decision) {
  return decision.reason;
}

module.exports = {
  DEFAULT_MIN_AVAILABLE_MB,
  DEFAULT_RESERVE_MB,
  DEFAULT_WORKER_MB,
  HARD_CAP_WORKERS,
  envInt,
  recommendVitestMaxWorkers,
  decideHeavyGate,
  formatHeavyGateRefusal,
};
