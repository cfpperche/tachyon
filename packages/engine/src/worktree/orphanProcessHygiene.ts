import fs from "node:fs";
import path from "node:path";

export interface OrphanProcessHygieneFs {
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: BufferEncoding): string;
  readlinkSync(file: string): string;
}

export interface OrphanedWorktreeProcess {
  pid: number;
  cwd: string;
  command: string;
}

export interface OrphanProcessHygieneReport {
  managedRoot: string;
  scanned: number;
  unreadable: number;
  /**
   * t-361963 — `/proc` is Linux. A failed walk is not an empty finding. `measured: false`
   * is the declared "did not measure" answer; callers must not treat an empty
   * `orphanedProcesses` list as "nothing is running". Two reasons share this field:
   * platform has no `/proc` (ENOENT/ENOTDIR) vs the walk failed where `/proc` exists.
   */
  measured: boolean;
  unavailableReason?: string;
  orphanedProcesses: OrphanedWorktreeProcess[];
}

export interface LiveWorktreeProcess {
  pid: number;
  cwd: string;
  command: string;
}

export interface LiveWorktreeProcessReport {
  worktreePath: string;
  scanned: number;
  unreadable: number;
  measured: boolean;
  unavailableReason?: string;
  processes: LiveWorktreeProcess[];
}

const DELETED_SUFFIX = " (deleted)";

export const PROC_UNAVAILABLE_REASON =
  "/proc is unavailable; process cwd cannot be measured on this system. Absence of a reading is not absence of processes.";

export const PROC_WALK_FAILED_REASON =
  "/proc exists but the process cwd walk failed. Absence of a reading is not absence of processes.";

export const CONFIRM_LIVE_PROCESSES_EXIT =
  "Pass confirmLiveProcesses=true to remove anyway — Tachyon will not kill them.";

/** Platform has no /proc — a permanent fact, not a finding. Removal must not refuse on this. */
export function isProcInstrumentAbsent(reason: string | undefined): boolean {
  return reason === PROC_UNAVAILABLE_REASON;
}

interface CwdProcess {
  pid: number;
  cwd: string;
  command: string;
  deleted: boolean;
}

interface CwdProcessScan {
  scanned: number;
  unreadable: number;
  measured: boolean;
  unavailableReason?: string;
  processes: CwdProcess[];
}

function underRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(`${root}${path.sep}`);
}

/**
 * One /proc walk. `worktree_processes` and the pre-removal probe share this so they
 * cannot disagree about which pids they saw.
 */
function scanCwdProcesses(
  root: string,
  procRoot: string,
  proc: OrphanProcessHygieneFs,
  requireDeleted: boolean,
): CwdProcessScan {
  const resolvedRoot = path.resolve(root);
  let names: string[];
  try {
    names = proc.readdirSync(procRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const instrumentAbsent = code === "ENOENT" || code === "ENOTDIR";
    return {
      scanned: 0,
      unreadable: 1,
      measured: false,
      unavailableReason: instrumentAbsent ? PROC_UNAVAILABLE_REASON : PROC_WALK_FAILED_REASON,
      processes: [],
    };
  }
  const processes: CwdProcess[] = [];
  let scanned = 0;
  let unreadable = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    scanned += 1;
    const processRoot = path.join(procRoot, name);
    let linkedCwd: string;
    try {
      linkedCwd = proc.readlinkSync(path.join(processRoot, "cwd"));
    } catch {
      unreadable += 1;
      continue;
    }
    const deleted = linkedCwd.endsWith(DELETED_SUFFIX);
    if (requireDeleted && !deleted) continue;
    const cwd = path.resolve(deleted ? linkedCwd.slice(0, -DELETED_SUFFIX.length) : linkedCwd);
    if (!underRoot(cwd, resolvedRoot)) continue;
    let command = "unknown";
    try {
      command = proc.readFileSync(path.join(processRoot, "comm"), "utf8").trim() || command;
    } catch {
      /* cwd is the identity proof; the command is optional operator context */
    }
    processes.push({ pid: Number(name), cwd, command, deleted });
  }
  processes.sort((a, b) => a.pid - b.pid);
  return { scanned, unreadable, measured: true, processes };
}

/**
 * Report processes whose cwd is a deleted checkout under this workspace's managed worktree root.
 *
 * Process lineage is deliberately irrelevant. A background process can be reparented before the
 * tmux session dies, while Linux keeps its deleted cwd visible through `/proc/<pid>/cwd`.
 */
export function scanOrphanedWorktreeProcesses(
  managedRoot: string,
  procRoot = "/proc",
  proc: OrphanProcessHygieneFs = fs,
): OrphanProcessHygieneReport {
  const root = path.resolve(managedRoot);
  const scan = scanCwdProcesses(root, procRoot, proc, true);
  return {
    managedRoot: root,
    scanned: scan.scanned,
    unreadable: scan.unreadable,
    measured: scan.measured,
    ...(scan.unavailableReason ? { unavailableReason: scan.unavailableReason } : {}),
    orphanedProcesses: scan.processes.map(({ pid, cwd, command }) => ({ pid, cwd, command })),
  };
}

/**
 * t-361963 — same walk as `scanOrphanedWorktreeProcesses`, but the checkout is still on disk
 * so cwd will not carry the ` (deleted)` suffix. `requireDeleted: false` is the only filter
 * change; pid/cwd/comm come from the same instrument.
 */
export function scanLiveWorktreeProcesses(
  worktreePath: string,
  procRoot = "/proc",
  proc: OrphanProcessHygieneFs = fs,
): LiveWorktreeProcessReport {
  const root = path.resolve(worktreePath);
  const scan = scanCwdProcesses(root, procRoot, proc, false);
  return {
    worktreePath: root,
    scanned: scan.scanned,
    unreadable: scan.unreadable,
    measured: scan.measured,
    ...(scan.unavailableReason ? { unavailableReason: scan.unavailableReason } : {}),
    processes: scan.processes.map(({ pid, cwd, command }) => ({ pid, cwd, command })),
  };
}

export function liveWorktreeProcessRefusal(
  worktreePath: string,
  report: LiveWorktreeProcessReport,
): string {
  if (!report.measured) {
    return (
      `worktree process probe cannot measure at ${worktreePath}: ${report.unavailableReason ?? PROC_WALK_FAILED_REASON} ` +
      CONFIRM_LIVE_PROCESSES_EXIT
    );
  }
  const listed = report.processes.map((p) => `pid ${p.pid} ${p.command}`).join("; ");
  const n = report.processes.length;
  const noun = n === 1 ? "process" : "processes";
  return (
    `worktree has ${n} live ${noun} with cwd under ${worktreePath}: ${listed}. ` +
    CONFIRM_LIVE_PROCESSES_EXIT
  );
}

/**
 * Only a measured finding, or a failed walk on a system that has `/proc`, blocks removal.
 * A platform without `/proc` is not a finding — callers proceed and declare they did not measure.
 */
export function liveWorktreeProcessBlocksRemoval(report: LiveWorktreeProcessReport): boolean {
  if (report.processes.length > 0) return true;
  if (report.measured) return false;
  return !isProcInstrumentAbsent(report.unavailableReason);
}
