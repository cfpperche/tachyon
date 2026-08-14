declare const hostResourceCostInputs: {
  DEFAULT_RESERVE_MB: number;
  DEFAULT_WORKER_MB: number;
  HARD_CAP_WORKERS: number;
  envInt(name: string): number | undefined;
};

export = hostResourceCostInputs;
