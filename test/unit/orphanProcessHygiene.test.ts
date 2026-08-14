import { describe, expect, it } from "vitest";
import path from "node:path";
import { scanOrphanedWorktreeProcesses, type OrphanProcessHygieneFs } from "@tachyon/engine/worktree/orphanProcessHygiene.js";

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
      orphanedProcesses: [],
    });
  });
});
