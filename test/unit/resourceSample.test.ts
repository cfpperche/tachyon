import { describe, it, expect } from "vitest";
import {
  ResourceSampler,
  cpuPctFromTicks,
  kbToMb,
  formatCpuPct,
  formatMemMb,
  subtreeRssKb,
  DEFAULT_CLK_TCK,
} from "@tachyon/engine/attention/resourceSample.js";

describe("resourceSample (spec 386)", () => {
  it("cpuPctFromTicks computes percent from tick deltas", () => {
    expect(cpuPctFromTicks(0, 0, 100, 1000, 100)).toBe(100);
    expect(cpuPctFromTicks(0, 0, 50, 1000, 100)).toBe(50);
    expect(cpuPctFromTicks(0, 0, 250, 1000, 100)).toBe(250);
  });

  it("cpuPctFromTicks ignores invalid deltas", () => {
    expect(cpuPctFromTicks(100, 1000, 50, 2000, 100)).toBeUndefined();
    expect(cpuPctFromTicks(0, 1000, 50, 1000, 100)).toBeUndefined();
  });

  it("kbToMb and formatters", () => {
    expect(kbToMb(2048)).toBe(2);
    expect(formatCpuPct(12.4)).toBe("12%");
    expect(formatMemMb(420)).toBe("420M");
    expect(formatMemMb(1536)).toBe("1.5G");
    expect(formatMemMb(10240)).toBe("10G");
  });

  it("ResourceSampler: first sample mem-only, second adds cpu", () => {
    let now = 1000;
    let t = 1000;
    const live = new ResourceSampler({
      get nowMs() { return now; },
      clkTck: DEFAULT_CLK_TCK,
      readTicks: () => t,
      readRssKb: () => 4096,
      childrenOf: () => [],
    });
    expect(live.sample("a", 1)).toEqual({ memMb: 4 });
    now = 2000;
    t = 1100; // +100 ticks / 1s / 100 = 100%
    const second = live.sample("a", 1);
    expect(second).toEqual({ memMb: 4, cpuPct: 100 });
  });

  it("ResourceSampler.clear drops prev so next is mem-only again", () => {
    let now = 0;
    let t = 0;
    const live = new ResourceSampler({
      get nowMs() { return now; },
      clkTck: 100,
      readTicks: () => t,
      readRssKb: () => 1024,
      childrenOf: () => [],
    });
    now = 1000; t = 100;
    live.sample("x", 1);
    now = 2000; t = 200;
    expect(live.sample("x", 1)?.cpuPct).toBe(100);
    live.clear("x");
    now = 3000; t = 300;
    expect(live.sample("x", 1)?.cpuPct).toBeUndefined();
  });

  it("subtreeRssKb returns null when root unreadable", () => {
    expect(subtreeRssKb(1, () => null, () => [])).toBeNull();
  });

  it("subtreeRssKb sums children", () => {
    const rss = (p: number) => (p === 10 ? 1000 : p === 11 ? 500 : null);
    expect(subtreeRssKb(10, rss, () => [11])).toBe(1500);
  });
});
