import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  PROC_UNAVAILABLE_REASON,
  scanLiveWorktreeProcesses,
  scanOrphanedWorktreeProcesses,
  type OrphanProcessHygieneFs,
} from "@tachyon/engine/worktree/orphanProcessHygiene.js";

function procFixture(entries: Record<string, { cwd?: string; command?: string }>): OrphanProcessHygieneFs {
  return {
    readdirSync: () => ["self", ...Object.keys(entries)],
    readlinkSync: (file) => {
      const pid = path.basename(path.dirname(file));
      const cwd = entries[pid]?.cwd;
      if (!cwd) throw new Error("unreadable cwd");
      return cwd;
    },
    readFileSync: (file) => {
      const pid = path.basename(path.dirname(file));
      return entries[pid]?.command ?? "";
    },
  };
}

describe("worktree orphan process hygiene", () => {
  it("reports deleted cwd processes under this workspace without relying on process lineage", () => {
    const root = "/cache/tachyon/worktrees/ws123";
    const report = scanOrphanedWorktreeProcesses(root, "/proc", procFixture({
      "41": { cwd: `${root}/worker (deleted)`, command: "node\n" },
      "42": { cwd: "/cache/tachyon/worktrees/other/worker (deleted)", command: "vite\n" },
      "43": { cwd: `${root}/live`, command: "watcher\n" },
      "44": {},
    }));

    expect(report).toEqual({
      managedRoot: root,
      scanned: 4,
      unreadable: 1,
      measured: true,
      orphanedProcesses: [{ pid: 41, cwd: `${root}/worker`, command: "node" }],
    });
  });

  it("fails visibly when proc cannot be read", () => {
    const proc = procFixture({});
    proc.readdirSync = () => { throw new Error("no proc"); };

    expect(scanOrphanedWorktreeProcesses("/worktrees/ws", "/proc", proc)).toEqual({
      managedRoot: "/worktrees/ws",
      scanned: 0,
      unreadable: 1,
      measured: false,
      unavailableReason: PROC_UNAVAILABLE_REASON,
      orphanedProcesses: [],
    });
  });
});

describe("t-361963: live cwd scan shares the orphan walk", () => {
  it("names a still-existing cwd under the checkout that the orphan filter ignores", () => {
    const root = "/cache/tachyon/worktrees/ws123/rev";
    const entries = {
      "41": { cwd: `${root} (deleted)`, command: "node\n" },
      "42": { cwd: root, command: "tail\n" },
      "43": { cwd: "/elsewhere", command: "sleep\n" },
    };
    expect(scanOrphanedWorktreeProcesses(root, "/proc", procFixture(entries)).orphanedProcesses)
      .toEqual([{ pid: 41, cwd: root, command: "node" }]);
    expect(scanLiveWorktreeProcesses(root, "/proc", procFixture(entries))).toEqual({
      worktreePath: root,
      scanned: 3,
      unreadable: 0,
      measured: true,
      processes: [
        { pid: 41, cwd: root, command: "node" },
        { pid: 42, cwd: root, command: "tail" },
      ],
    });
  });

  it("declares the instrument unavailable instead of looking like an empty finding", () => {
    const proc = procFixture({});
    proc.readdirSync = () => { throw new Error("no proc"); };
    const report = scanLiveWorktreeProcesses("/wt/rev", "/proc", proc);
    expect(report.measured).toBe(false);
    expect(report.processes).toEqual([]);
    expect(report.unavailableReason).toBe(PROC_UNAVAILABLE_REASON);
  });
});
