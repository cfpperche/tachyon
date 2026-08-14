/**
 * spec 386 — live CPU% + RSS for an agent pane subtree (Linux /proc).
 * CPU reuses cumulative ticks (same one-level children as attention/cpu.ts);
 * percent needs two samples spaced in wall time.
 */
import fs from "node:fs";
import { subtreeCpuTicks } from "./cpu.js";

/** Default Linux USER_HZ; override in tests. */
export const DEFAULT_CLK_TCK = 100;

export interface ResourceSample {
  /** CPU percent of the subtree since the previous sample; omitted on first sample. */
  cpuPct?: number;
  /** Resident set size of the subtree in MiB. */
  memMb: number;
}

export interface ResourceSampleOpts {
  nowMs?: number;
  clkTck?: number;
  /** inject for tests */
  readTicks?: (pid: number) => number | null;
  readRssKb?: (pid: number) => number | null;
  childrenOf?: (pid: number) => number[];
}

/** One-level children of pid (exported for tests). */
export function childrenOf(pid: number): number[] {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

function rssKbOf(pid: number): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    if (!m) return null;
    const kb = Number.parseInt(m[1], 10);
    return Number.isNaN(kb) ? null : kb;
  } catch {
    return null;
  }
}

/** Sum VmRSS of pid + one level of children (kB). null if the root pid is unreadable. */
export function subtreeRssKb(
  pid: number,
  readRssKb: (p: number) => number | null = rssKbOf,
  listChildren: (p: number) => number[] = childrenOf,
): number | null {
  const own = readRssKb(pid);
  if (own === null) return null;
  let total = own;
  for (const child of listChildren(pid)) {
    total += readRssKb(child) ?? 0;
  }
  return total;
}

export function kbToMb(kb: number): number {
  return Math.max(0, Math.round(kb / 1024));
}

/**
 * Compute CPU% from two tick samples: (Δticks / Δsec / clkTck) * 100.
 * Can exceed 100 with multi-core work in the subtree.
 */
export function cpuPctFromTicks(prevTicks: number, prevMs: number, ticks: number, nowMs: number, clkTck = DEFAULT_CLK_TCK): number | undefined {
  const dtMs = nowMs - prevMs;
  if (dtMs <= 0) return undefined;
  const dTicks = ticks - prevTicks;
  if (dTicks < 0) return undefined; // pid recycle / wrap — wait for next sample
  const pct = (dTicks / (dtMs / 1000) / clkTck) * 100;
  if (!Number.isFinite(pct)) return undefined;
  return Math.max(0, Math.min(999, pct));
}

type Prev = { ticks: number; ms: number };

/**
 * Process-lifetime sampler keyed by agent name. First call yields mem only;
 * subsequent calls add cpuPct from tick deltas.
 */
export class ResourceSampler {
  private readonly prev = new Map<string, Prev>();
  constructor(private readonly opts: ResourceSampleOpts = {}) {}

  /** Drop state when an agent stops (optional hygiene). */
  clear(agent: string): void {
    this.prev.delete(agent);
  }

  /** Agents currently tracked (have a previous tick sample). */
  keys(): string[] {
    return [...this.prev.keys()];
  }

  sample(agent: string, panePid: number): ResourceSample | undefined {
    const nowMs = this.opts.nowMs ?? Date.now();
    const clkTck = this.opts.clkTck ?? DEFAULT_CLK_TCK;
    const readTicks = this.opts.readTicks ?? subtreeCpuTicks;
    const readRss = this.opts.readRssKb ?? rssKbOf;

    const listChildren = this.opts.childrenOf ?? childrenOf;
    const ticks = readTicks(panePid);
    const rssKb = subtreeRssKb(panePid, readRss, listChildren);
    if (rssKb === null && ticks === null) return undefined;

    const memMb = rssKb === null ? 0 : kbToMb(rssKb);
    const out: ResourceSample = { memMb };

    if (ticks !== null) {
      const p = this.prev.get(agent);
      if (p) {
        const cpu = cpuPctFromTicks(p.ticks, p.ms, ticks, nowMs, clkTck);
        if (cpu !== undefined) out.cpuPct = cpu;
      }
      this.prev.set(agent, { ticks, ms: nowMs });
    }

    return out;
  }
}

/** Format helpers for peek / lanes (pure). */
export function formatCpuPct(n: number): string {
  return `${Math.round(n)}%`;
}

export function formatMemMb(mb: number): string {
  if (mb >= 1024) {
    const g = mb / 1024;
    const s = g >= 10 ? g.toFixed(0) : g.toFixed(1).replace(/\.0$/, "");
    return `${s}G`;
  }
  return `${Math.round(mb)}M`;
}
