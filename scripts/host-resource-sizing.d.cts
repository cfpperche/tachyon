import hostMemory = require("../packages/shared/host-memory.cjs");

declare namespace hostResourceSizing {
  type HostMemorySnapshot = hostMemory.HostMemorySnapshot;
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
  type HeavyGateInput = { memory?: HostMemorySnapshot; cpuCount?: number; minAvailableMb?: number };
}

declare const hostResourceSizing: {
  DEFAULT_MIN_AVAILABLE_MB: number;
  DEFAULT_RESERVE_MB: number;
  DEFAULT_WORKER_MB: number;
  HARD_CAP_WORKERS: number;
  envInt(name: string): number | undefined;
  recommendVitestMaxWorkers(input: hostResourceSizing.WorkerSizingInput): number;
  decideHeavyGate(input?: hostResourceSizing.HeavyGateInput): hostResourceSizing.HeavyGateDecision;
  formatHeavyGateRefusal(decision: Extract<hostResourceSizing.HeavyGateDecision, { ok: false }>): string;
};

export = hostResourceSizing;
