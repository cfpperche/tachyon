/**
 * t-17674a — wall-clock attribution for a late host tick.
 *
 * ELU says the thread was inside a callback; it does not say which one. A CPU profile
 * is the same trap (self time is not caller attribution, and a blocking syscall has
 * almost no CPU). This wraps the sync filesystem doors the host actually uses and
 * keeps the hottest call site by cumulative wall time. Classification is unchanged.
 *
 * Sync subprocess APIs are deliberately not named here: this file runs inside the
 * extension host, so it cannot join the wedge allowlist (those slots are for
 * separate processes with no VS Code running).
 */
import fs from "node:fs";
import path from "node:path";

export interface HostSyncIoHit {
  op: string;
  /** Wall time of the single longest wrapped call. */
  ms: number;
  /** Sum of every wrapped call in the interval — frequency × cost. */
  totalMs: number;
  calls: number;
  path?: string;
  site?: string;
}

const SKIP_IN_STACK = /hostSyncIoProbe\.ts|node:fs|node:internal/;

let installed = false;
let longestMs = 0;
let longestOp = "";
let longestPath: string | undefined;
let totalMs = 0;
let calls = 0;
const bySite = new Map<string, { ms: number; op: string; path?: string }>();
const originals = {
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  readSync: fs.readSync,
};

function siteFromStack(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(2)) {
    if (SKIP_IN_STACK.test(line)) continue;
    const match = line.match(/\(([^)]+):(\d+):\d+\)/) ?? line.match(/at ([^ ]+):(\d+):\d+/);
    if (!match) continue;
    return `${path.basename(match[1])}:${match[2]}`;
  }
  return undefined;
}

function record(op: string, started: number, target?: unknown): void {
  const ms = performance.now() - started;
  if (ms <= 0) return;
  totalMs += ms;
  calls += 1;
  const pathArg = typeof target === "string" ? target : undefined;
  if (ms > longestMs) {
    longestMs = ms;
    longestOp = op;
    longestPath = pathArg;
  }
  const site = siteFromStack();
  if (!site) return;
  const prev = bySite.get(site);
  if (!prev) bySite.set(site, { ms, op, path: pathArg });
  else {
    prev.ms += ms;
    if (pathArg) prev.path = pathArg;
  }
}

function wrap<T extends (...args: never[]) => unknown>(
  op: string,
  original: T,
  pathArg = 0,
): T {
  return ((...args: Parameters<T>) => {
    const started = performance.now();
    try {
      return original(...args);
    } finally {
      record(op, started, args[pathArg]);
    }
  }) as T;
}

/** Install once. Safe to call again; the second call is a no-op. */
export function startHostSyncIoProbe(): void {
  if (installed) return;
  installed = true;
  fs.readFileSync = wrap("readFileSync", originals.readFileSync);
  fs.readdirSync = wrap("readdirSync", originals.readdirSync);
  fs.readSync = wrap("readSync", originals.readSync);
}

function reset(): void {
  longestMs = 0;
  longestOp = "";
  longestPath = undefined;
  totalMs = 0;
  calls = 0;
  bySite.clear();
}

/** Hottest site (by cumulative ms) since the previous take, then reset. */
export function takeHostSyncIoHit(): HostSyncIoHit | undefined {
  if (calls === 0) return undefined;
  let site: string | undefined;
  let siteMs = 0;
  let siteOp = longestOp;
  let sitePath = longestPath;
  for (const [key, value] of bySite) {
    if (value.ms > siteMs) {
      site = key;
      siteMs = value.ms;
      siteOp = value.op;
      sitePath = value.path;
    }
  }
  const hit: HostSyncIoHit = {
    op: siteOp || longestOp,
    ms: longestMs,
    totalMs,
    calls,
    ...(site ? { site } : {}),
    ...(sitePath ? { path: sitePath } : {}),
  };
  reset();
  return hit;
}

/** Test seam — restore originals and drop the recorded hit. */
export function stopHostSyncIoProbe(): void {
  if (!installed) return;
  fs.readFileSync = originals.readFileSync;
  fs.readdirSync = originals.readdirSync;
  fs.readSync = originals.readSync;
  installed = false;
  reset();
}
