/**
 * t-019dac — host memory awareness for heavy gates (verify:full / verify_task full).
 * Auto-size vitest workers from free RAM; fail-closed under pressure.
 *
 * CommonJS is deliberate, and it is the only format both consumers can read: extension-host source
 * compiles as CJS and cannot import an `.mjs` (TS1479), while `scripts/verify-full.mjs` is run by
 * plain node and cannot import a `.ts`. `.cjs` + `.d.cts` is what `shared/verify-record-validity`
 * and `shared/dependency-lockfile-validity` already established for exactly this reason.
 *
 * t-da6b78 — this used to be TWO implementations: `src/host/hostResources.ts` and a hand-kept ESM
 * twin at `scripts/host-resources.mjs`, synchronised by human memory. `scripts/` is outside
 * tsconfig's include, so the twin had no type protection at all — which is how t-0b7aa7 happened.
 *
 * Env overrides:
 *   TACHYON_VITEST_MAX_WORKERS          force worker count
 *   TACHYON_VERIFY_MIN_AVAILABLE_MB     refuse below this free RAM (default 2048)
 *   TACHYON_VERIFY_RESERVE_MB           keep for control plane (default 3072)
 *   TACHYON_VERIFY_WORKER_MB            assumed cost per vitest worker (default 320)
 *   TACHYON_VERIFY_MEMINFO_PATH         override /proc/meminfo (tests)
 *   TACHYON_VERIFY_REQUIRE_MEMINFO=1    refuse when meminfo unreadable
 */
const { readFileSync } = require("node:fs");
const { cpus } = require("node:os");

const DEFAULT_MIN_AVAILABLE_MB = 2048;
const DEFAULT_RESERVE_MB = 3072;
/**
 * t-3ad4af — 768 was an estimate and it was wrong by ~2.7x. Sampling PSS per process across the full
 * `test/unit` suite, a single pool worker never exceeded 289MB and the marginal cost of adding one
 * was 215MB. The estimate mattered: it is the divisor of the whole budget, so the sizer was wrong at
 * the source. The rest of a run's cost is not per-worker at all — see `src/host/vitestBudget.ts`,
 * which owns the fixed per-invocation term this module never modelled.
 */
const DEFAULT_WORKER_MB = 320;
const HARD_CAP_WORKERS = 16;

function envInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Parse Linux /proc/meminfo kB fields into MiB. */
function parseMeminfo(text) {
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

function readHostMemory(readFile = (p) => readFileSync(p, "utf8")) {
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
function recommendVitestMaxWorkers(input) {
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

/**
 * Fail-closed gate for heavy work (full suite / verify_task full).
 *
 * t-0b7aa7 — a REFUSAL carries no worker count, on purpose, and this is a RUNTIME property, not
 * merely a typing one. The `ok: false` branch used to answer `workers: 0`, which made `workers`
 * present on both branches and therefore readable as a plain number without ever consulting `ok`.
 * Zero was the honest value for "not running" and exactly the wrong SHAPE: a refusal that answers a
 * sizing question at all will eventually be read as a size. Omitting the key makes a blind read
 * yield `undefined` — which fails loudly — instead of `0`, which passes for a legitimate size. The
 * `.d.cts` union turns the same mistake into a compile error for TypeScript callers; `verify-full.mjs`
 * gets no such help, so the shape is what protects it.
 */
function decideHeavyGate(input = {}) {
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

function formatHeavyGateRefusal(decision) {
  return decision.reason;
}

module.exports = {
  DEFAULT_MIN_AVAILABLE_MB,
  DEFAULT_RESERVE_MB,
  DEFAULT_WORKER_MB,
  HARD_CAP_WORKERS,
  parseMeminfo,
  readHostMemory,
  recommendVitestMaxWorkers,
  decideHeavyGate,
  formatHeavyGateRefusal,
};
