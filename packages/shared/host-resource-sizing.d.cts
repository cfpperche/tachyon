/**
 * The type contract for `host-resource-sizing.cjs`. It is a DECLARATION of the one runtime
 * implementation, not a second one — the same relationship `verify-record-validity.d.cts` and
 * `dependency-lockfile-validity.d.cts` already have with their modules.
 *
 * A namespace rather than a bare `declare const` because this contract carries TYPES the consumers
 * need (`HostMemorySnapshot`, `HeavyGateDecision`), and a variable declaration cannot hold them.
 * The consumption shape is unchanged: default-import, then destructure.
 */
declare namespace hostResourceSizing {
  type HostMemorySnapshot = {
    memTotalMb: number;
    memAvailableMb: number;
    swapTotalMb: number;
    swapFreeMb: number;
    source: "proc-meminfo" | "unavailable";
  };

  /**
   * t-0b7aa7 — a REFUSAL carries no worker count. The `ok: false` branch used to say `workers: 0`,
   * which made `workers` present on both branches and readable as a plain `number` without ever
   * consulting `ok`. Dropping the field makes the compiler refuse `decision.workers` until the
   * caller has narrowed on `ok`, so the mistake is a type error instead of a number that travels.
   * The runtime module omits the key for the same reason, which is what protects `verify-full.mjs`.
   */
  type HeavyGateDecision =
    | { ok: true; workers: number; memory: HostMemorySnapshot; reason: string }
    | { ok: false; code: "MEMORY_PRESSURE" | "MEMORY_UNAVAILABLE"; memory: HostMemorySnapshot; reason: string };

  type WorkerSizingInput = {
    memory: HostMemorySnapshot;
    cpuCount: number;
    reserveMb?: number;
    workerMb?: number;
    hardCap?: number;
  };

  type HeavyGateInput = {
    memory?: HostMemorySnapshot;
    cpuCount?: number;
    minAvailableMb?: number;
  };
}

declare const hostResourceSizing: {
  DEFAULT_MIN_AVAILABLE_MB: number;
  DEFAULT_RESERVE_MB: number;
  DEFAULT_WORKER_MB: number;
  HARD_CAP_WORKERS: number;
  envInt(name: string): number | undefined;
  parseMeminfo(text: string): hostResourceSizing.HostMemorySnapshot | undefined;
  readHostMemory(readFile?: (path: string) => string): hostResourceSizing.HostMemorySnapshot;
  recommendVitestMaxWorkers(input: hostResourceSizing.WorkerSizingInput): number;
  decideHeavyGate(input?: hostResourceSizing.HeavyGateInput): hostResourceSizing.HeavyGateDecision;
  formatHeavyGateRefusal(decision: Extract<hostResourceSizing.HeavyGateDecision, { ok: false }>): string;
};

export = hostResourceSizing;
