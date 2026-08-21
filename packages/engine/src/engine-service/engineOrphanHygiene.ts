import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  scanOrphanedWorktreeProcesses,
  type OrphanProcessHygieneReport,
} from "../worktree/orphanProcessHygiene.js";

const execFileAsync = promisify(execFile);
const ENGINE_TITLE = /^tachyon-engine:[a-f0-9]{8}\0/i;
const ENGINE_UNIT = /^tachyon-engine-[a-f0-9]{32}\.service$/i;

export interface EngineOrphanHygieneReport {
  measured: boolean;
  stopped: string[];
  refused: string[];
}

export interface EngineOrphanHygieneAdapters {
  scan(): OrphanProcessHygieneReport;
  readCmdline(pid: number): string;
  readCgroup(pid: number): string;
  readMainPid(unit: string): Promise<number>;
  stopUnit(unit: string): Promise<void>;
}

function unitFromCgroup(value: string): string | undefined {
  for (const line of value.split("\n")) {
    const leaf = line.slice(line.lastIndexOf("/") + 1);
    if (ENGINE_UNIT.test(leaf)) return leaf;
  }
  return undefined;
}

function productionAdapters(): EngineOrphanHygieneAdapters {
  return {
    // The existing worktree hygiene walk is deliberately reused. Root '/' means the deleted-cwd
    // proof is not coupled to one producer: managed worktrees, extension smoke and Dev Host all
    // arrive through the same Linux fact.
    scan: () => scanOrphanedWorktreeProcesses("/"),
    readCmdline: (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"),
    readCgroup: (pid) => fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"),
    readMainPid: async (unit) => {
      const { stdout } = await execFileAsync("systemctl", ["--user", "show", unit, "--property=MainPID", "--value"], { encoding: "utf8" });
      return Number(stdout.trim());
    },
    stopUnit: async (unit) => {
      await execFileAsync("systemctl", ["--user", "stop", unit], { encoding: "utf8" });
      await execFileAsync("systemctl", ["--user", "reset-failed", unit], { encoding: "utf8" }).catch(() => undefined);
    },
  };
}

/**
 * Stop only engines whose workspace directory has already been deleted.
 *
 * Actor × trigger: every VS Code extension activation runs this once. Engines for open or merely
 * still-existing workspaces never enter the deleted-cwd scan. A candidate must additionally prove
 * its process title, exact systemd cgroup unit, and stable MainPID immediately before stop. Any
 * unreadable or drifting identity is a refusal, never a best-effort kill.
 */
export async function reapOrphanedEngineDaemons(
  adapters: EngineOrphanHygieneAdapters = productionAdapters(),
): Promise<EngineOrphanHygieneReport> {
  if (process.platform !== "linux" && arguments.length === 0) return { measured: false, stopped: [], refused: [] };
  const scan = adapters.scan();
  if (!scan.measured) {
    return { measured: false, stopped: [], refused: [scan.unavailableReason ?? "engine orphan scan unavailable"] };
  }
  const stopped: string[] = [];
  const refused: string[] = [];
  for (const candidate of scan.orphanedProcesses) {
    if (candidate.command !== "tachyon-engine:") continue;
    let unit: string | undefined;
    try {
      if (!ENGINE_TITLE.test(adapters.readCmdline(candidate.pid))) continue;
      unit = unitFromCgroup(adapters.readCgroup(candidate.pid));
      if (!unit) {
        refused.push(`pid ${candidate.pid}: engine systemd unit could not be proven`);
        continue;
      }
      const first = await adapters.readMainPid(unit);
      const second = await adapters.readMainPid(unit);
      if (first !== candidate.pid || second !== candidate.pid) {
        refused.push(`pid ${candidate.pid}: engine unit identity changed before shutdown`);
        continue;
      }
      await adapters.stopUnit(unit);
      stopped.push(unit);
    } catch (error) {
      refused.push(`pid ${candidate.pid}${unit ? ` unit ${unit}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { measured: true, stopped, refused };
}
