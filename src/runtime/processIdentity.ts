/**
 * Linux process identity — pid + start time + boot id, read from /proc.
 *
 * t-e88c8a moved this out of `src/delivery/reloadReconciliation.ts`. It lived there because the
 * Delivery lease was its first caller, but the thing it answers is not about Delivery at all: "is
 * THIS pid still the same process I saw before, on the same boot". tmux ownership, the engine
 * supervisor and the engine service all ask exactly that, and they outlive Delivery.
 *
 * The three-state result is the whole point. `unknown` is never collapsed into `gone`: an unreadable
 * /proc is not proof of death, and a caller that treats it as one will happily reap a live process.
 */
import fs from "node:fs";

/**
 * Live process observation for one agent.
 * - exact: readable Linux identity that can match a durable holder
 * - gone: process definitively absent (ENOENT)
 * - unknown: unsupported/unreadable/malformed — never treated as gone
 */
export type ObservedProcess =
  | { state: "exact"; pid: number; processStart: string; bootId: string }
  | { state: "gone" }
  | { state: "unknown"; reason: string };

/**
 * Read Linux process identity for `pid`.
 * Parses `/proc/<pid>/stat` after the final `)` so spaces/parentheses in `comm` are safe,
 * and pairs it with `/proc/sys/kernel/random/boot_id`.
 * Unsupported/unreadable/malformed → unknown (never invents gone).
 */
export function readLinuxProcessIdentity(pid: number): ObservedProcess {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: "unknown", reason: "invalid pid" };
  }
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "gone" };
    return { state: "unknown", reason: code ? `stat ${code}` : "stat unreadable" };
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return { state: "unknown", reason: "malformed stat (no closing paren)" };
  const after = stat.slice(close + 2).trimStart().split(/\s+/);
  // After comm: field 3=state … field 22=starttime → 0-based index 19.
  const processStart = after[19];
  if (!processStart || !/^\d+$/.test(processStart)) {
    return { state: "unknown", reason: "malformed process start time" };
  }
  let bootId: string;
  try {
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { state: "unknown", reason: code ? `boot_id ${code}` : "boot_id unreadable" };
  }
  if (!bootId) return { state: "unknown", reason: "boot_id empty" };
  return { state: "exact", pid, processStart, bootId };
}
