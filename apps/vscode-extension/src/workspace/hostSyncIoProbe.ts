/**
 * t-17674a — wall-clock attribution for a late host tick.
 *
 * ELU says the thread was inside a callback; it does not say which one. A CPU profile
 * is the same trap (self time is not caller attribution, and a blocking syscall has
 * almost no CPU). This wraps the synchronous filesystem and subprocess doors the host uses and
 * keeps the hottest call site by cumulative wall time. Classification is unchanged.
 *
 * It still measures only wall time inside each wrapped call: a zero syncTotalMs
 * rules out waiting in these doors, not a callback that returned from I/O quickly
 * and then blocked elsewhere.
 * Six production-door activation smokes measured 17 median / 28 max calls across
 * the seven added doors: 0.85 ms median / 1.39 ms max at the measured 49.754 µs
 * wrapper overhead. That is small enough to keep caller attribution on every call.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

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
let attributableCalls = 0;
let attributionSuppressionDepth = 0;
let recording = false;
const bySite = new Map<string, { ms: number; op: string; path?: string }>();
const originals = {
  appendFileSync: fs.appendFileSync,
  execFileSync: childProcess.execFileSync,
  mkdirSync: fs.mkdirSync,
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  readSync: fs.readSync,
  renameSync: fs.renameSync,
  spawnSync: childProcess.spawnSync,
  statSync: fs.statSync,
  writeFileSync: fs.writeFileSync,
};

// existsSync is intentionally not wrapped. Measuring the real wrapper on this
// host added a 49.8 µs median per call (100k-call batches), and existsSync is the
// highest-volume synchronous door in the extension host. The lower-frequency
// doors below retain attribution without putting that tax on every existence check.

function siteFromStack(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(2)) {
    if (SKIP_IN_STACK.test(line)) continue;
    const match = line.match(/\(([^)]+):(\d+):\d+\)/) ?? line.match(/at ([^ ]+):(\d+):\d+/);
    if (!match) continue;
    return `${match[1]}:${match[2]}`;
  }
  return undefined;
}

function record(op: string, started: number, target?: unknown): void {
  if (recording) return;
  recording = true;
  try {
    const ms = performance.now() - started;
    if (ms <= 0) return;
    totalMs += ms;
    calls += 1;
    if (attributionSuppressionDepth > 0) return;
    attributableCalls += 1;
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
  } finally {
    recording = false;
  }
}

function wrap<T extends (...args: never[]) => unknown>(
  op: string,
  original: T,
  pathArg = 0,
): T {
  return ((...args: Parameters<T>) => {
    if (recording) return original(...args);
    recording = true;
    const started = performance.now();
    try {
      return original(...args);
    } finally {
      recording = false;
      record(op, started, args[pathArg]);
    }
  }) as T;
}

/** Install once. Safe to call again; the second call is a no-op. */
export function startHostSyncIoProbe(): void {
  if (installed) return;
  installed = true;
  fs.appendFileSync = wrap("appendFileSync", originals.appendFileSync);
  childProcess.execFileSync = wrap("execFileSync", originals.execFileSync);
  fs.mkdirSync = wrap("mkdirSync", originals.mkdirSync);
  fs.readFileSync = wrap("readFileSync", originals.readFileSync);
  fs.readdirSync = wrap("readdirSync", originals.readdirSync);
  fs.readSync = wrap("readSync", originals.readSync);
  fs.renameSync = wrap("renameSync", originals.renameSync);
  childProcess.spawnSync = wrap("spawnSync", originals.spawnSync);
  (fs as { statSync: typeof fs.statSync }).statSync = wrap("statSync", originals.statSync);
  fs.writeFileSync = wrap("writeFileSync", originals.writeFileSync);
  // Production subprocess callers use named ESM imports. Refresh their live
  // bindings after patching the built-in default exports (and again on restore).
  syncBuiltinESMExports();
}

/**
 * Measure synchronous I/O performed by the lag detector without attributing it as
 * the cause of that same lag. Origin scoping survives bundling, unlike stack-file
 * filters, and avoids teaching the probe one special path such as schedstat.
 */
export function withoutHostSyncIoAttribution<T>(operation: () => T): T {
  attributionSuppressionDepth += 1;
  try {
    return operation();
  } finally {
    attributionSuppressionDepth -= 1;
  }
}

function reset(): void {
  longestMs = 0;
  longestOp = "";
  longestPath = undefined;
  totalMs = 0;
  calls = 0;
  attributableCalls = 0;
  bySite.clear();
}

/** Hottest site (by cumulative ms) since the previous take, then reset. */
export function takeHostSyncIoHit(): HostSyncIoHit | undefined {
  if (calls === 0) return undefined;
  // A detector-only window has measured I/O but no honest attribution. Returning
  // no hit makes an empty syncSite intentional instead of accusing the detector.
  if (attributableCalls === 0) {
    reset();
    return undefined;
  }
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
  fs.appendFileSync = originals.appendFileSync;
  childProcess.execFileSync = originals.execFileSync;
  fs.mkdirSync = originals.mkdirSync;
  fs.readFileSync = originals.readFileSync;
  fs.readdirSync = originals.readdirSync;
  fs.readSync = originals.readSync;
  fs.renameSync = originals.renameSync;
  childProcess.spawnSync = originals.spawnSync;
  (fs as { statSync: typeof fs.statSync }).statSync = originals.statSync;
  fs.writeFileSync = originals.writeFileSync;
  syncBuiltinESMExports();
  installed = false;
  reset();
}
