declare namespace hostMemory {
  type HostMemorySnapshot = {
    memTotalMb: number;
    memAvailableMb: number;
    swapTotalMb: number;
    swapFreeMb: number;
    source: "proc-meminfo" | "unavailable";
  };
}

declare const hostMemory: {
  parseMeminfo(text: string): hostMemory.HostMemorySnapshot | undefined;
  readHostMemory(readFile?: (path: string) => string, path?: string): hostMemory.HostMemorySnapshot;
};

export = hostMemory;
