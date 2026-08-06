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
  orphanedProcesses: OrphanedWorktreeProcess[];
}

const DELETED_SUFFIX = " (deleted)";

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
  const orphanedProcesses: OrphanedWorktreeProcess[] = [];
  let names: string[];
  try {
    names = proc.readdirSync(procRoot);
  } catch {
    return { managedRoot: root, scanned: 0, unreadable: 1, orphanedProcesses };
  }
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
    if (!linkedCwd.endsWith(DELETED_SUFFIX)) continue;
    const cwd = path.resolve(linkedCwd.slice(0, -DELETED_SUFFIX.length));
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) continue;
    let command = "unknown";
    try {
      command = proc.readFileSync(path.join(processRoot, "comm"), "utf8").trim() || command;
    } catch {
      /* cwd is the identity proof; the command is optional operator context */
    }
    orphanedProcesses.push({ pid: Number(name), cwd, command });
  }
  orphanedProcesses.sort((a, b) => a.pid - b.pid);
  return { managedRoot: root, scanned, unreadable, orphanedProcesses };
}
