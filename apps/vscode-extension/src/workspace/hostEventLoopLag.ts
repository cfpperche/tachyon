import fs from "node:fs";
import { withoutHostSyncIoAttribution } from "./hostSyncIoProbe.js";

/**
 * t-0bf709 — classify a late host timer tick.
 *
 * The 5s setInterval in extension.ts only sees that a timer fired late. The two
 * remedies are opposites (dispatch fewer agents vs pull work off the host thread),
 * so the tick has to say which one it was. Method, measured 2026-08-15:
 *
 *   Date.now() lag vs process.hrtime (CLOCK_MONOTONIC): a wall jump with no
 *   monotonic lag is a clock step, not an event-loop stall (WSL does this).
 *   eventLoopUtilization + process.cpuUsage over the same interval: high
 *   utilization or high CPU fraction means the host thread was in a callback
 *   (sync JS or a blocking syscall).
 *   /proc/self/schedstat run_delay + loadavg/ncpu: the process was runnable
 *   and waited for a CPU — contention, not a code defect.
 *
 * ELU is sampled from the previous tick to this one (a same-turn sample is
 * blind: counters only move after an event-loop phase).
 */

export const HOST_LAG_INTERVAL_MS = 5_000;
export const HOST_LAG_NOTIFY_THRESHOLD_MS = 5_000;

export type HostLagCause = "sync-work" | "cpu-contention" | "clock-jump" | "unknown";

export interface HostLagInput {
  /** Date.now() minus the expected fire time. Includes CLOCK_REALTIME jumps. */
  wallLagMs: number;
  /** hrtime elapsed minus the interval. Ignores NTP; ignores suspend on Linux. */
  hrLagMs: number;
  eluActiveMs: number;
  eluIdleMs: number;
  cpuMs: number;
  loadavg1: number;
  cpuCount: number;
  /** Delta of /proc/self/schedstat field 2 over the interval, if readable. */
  runDelayMs?: number;
}

export interface HostLagSample extends HostLagInput {
  cause: HostLagCause;
  utilization: number;
  cpuRatio: number;
  loadPerCpu: number;
}

export function classifyHostLag(input: HostLagInput): HostLagSample {
  const eluTotal = Math.max(0, input.eluActiveMs) + Math.max(0, input.eluIdleMs);
  const utilization = eluTotal > 0 ? input.eluActiveMs / eluTotal : 0;
  const observedMs = Math.max(HOST_LAG_INTERVAL_MS + Math.max(0, input.hrLagMs), eluTotal, 1);
  const cpuRatio = Math.max(0, input.cpuMs) / observedMs;
  const cpuCount = input.cpuCount > 0 ? input.cpuCount : 1;
  const loadPerCpu = input.loadavg1 / cpuCount;
  const runDelayMs = input.runDelayMs ?? 0;
  const clockSkewMs = input.wallLagMs - input.hrLagMs;

  let cause: HostLagCause = "unknown";
  if (input.wallLagMs > HOST_LAG_NOTIFY_THRESHOLD_MS && clockSkewMs > 2_000 && input.hrLagMs < 1_000) {
    cause = "clock-jump";
  } else if (cpuRatio >= 0.4 || (utilization >= 0.4 && input.hrLagMs > HOST_LAG_NOTIFY_THRESHOLD_MS)) {
    cause = "sync-work";
  } else if (runDelayMs >= 1_000 || (loadPerCpu >= 0.5 && cpuRatio < 0.2 && utilization < 0.3)) {
    cause = "cpu-contention";
  }

  return { ...input, cause, utilization, cpuRatio, loadPerCpu };
}

export function shouldNotifyHostLag(sample: HostLagSample): boolean {
  return sample.wallLagMs > HOST_LAG_NOTIFY_THRESHOLD_MS && sample.cause !== "clock-jump";
}

/** English keys must be l10n.t() string literals so i18n.test.ts can see them. */
export function localizeHostLagNotice(
  l10n: { t(message: string, ...args: Array<string | number | boolean>): string },
  cause: HostLagCause,
  lagMs: number,
): string {
  const n = Math.round(lagMs);
  switch (cause) {
    case "sync-work":
      return l10n.t("Tachyon host thread was busy for {0}ms. Nothing broke — do not restart the Bridge.", n);
    case "cpu-contention":
      return l10n.t("Tachyon host waited {0}ms for CPU. Nothing broke — do not restart the Bridge.", n);
    default:
      return l10n.t("Tachyon host timer was late by {0}ms. Nothing broke — do not restart the Bridge.", n);
  }
}

export function formatHostLagLog(
  sample: HostLagSample,
  syncIo?: { op: string; ms: number; totalMs?: number; calls?: number; path?: string; site?: string },
): string {
  const delay = sample.runDelayMs === undefined ? "n/a" : String(Math.round(sample.runDelayMs));
  const fields = [
    `cause=${sample.cause}`,
    `lagMs=${Math.round(sample.wallLagMs)}`,
    `hrLagMs=${Math.round(sample.hrLagMs)}`,
    `elu=${sample.utilization.toFixed(3)}`,
    `cpuMs=${Math.round(sample.cpuMs)}`,
    `cpuRatio=${sample.cpuRatio.toFixed(3)}`,
    `load=${sample.loadavg1.toFixed(2)}/${sample.cpuCount}`,
    `runDelayMs=${delay}`,
  ];
  // t-17674a — extra fields only. Classification above is untouched.
  if (syncIo && (syncIo.ms > 0 || (syncIo.totalMs ?? 0) > 0)) {
    fields.push(`syncOp=${syncIo.op}`, `syncMs=${Math.round(syncIo.ms)}`);
    if (typeof syncIo.totalMs === "number") fields.push(`syncTotalMs=${Math.round(syncIo.totalMs)}`);
    if (typeof syncIo.calls === "number") fields.push(`syncCalls=${syncIo.calls}`);
    if (syncIo.site) fields.push(`syncSite=${syncIo.site}`);
    if (syncIo.path) fields.push(`syncPath=${syncIo.path}`);
  }
  return fields.join(" ");
}

/** Best-effort; undefined on non-Linux or if /proc is unreadable. */
export function readLinuxRunDelayMs(): number | undefined {
  try {
    const raw = withoutHostSyncIoAttribution(() =>
      fs.readFileSync("/proc/self/schedstat", "utf8").trim().split(/\s+/),
    );
    const delayNs = Number(raw[1]);
    return Number.isFinite(delayNs) ? delayNs / 1e6 : undefined;
  } catch {
    return undefined;
  }
}
