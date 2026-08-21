import { describe, expect, it } from "vitest";
import {
  reapOrphanedEngineDaemons,
  type EngineOrphanHygieneAdapters,
} from "@tachyon/engine/engine-service/engineOrphanHygiene.js";

function adapters(input: {
  orphaned: Array<{ pid: number; cwd: string; command: string }>;
  cmdlines?: Record<number, string>;
  cgroups?: Record<number, string>;
  mainPids?: Record<string, number[]>;
}): EngineOrphanHygieneAdapters & { stopped: string[] } {
  const stopped: string[] = [];
  const reads = new Map<string, number>();
  return {
    stopped,
    scan: () => ({ managedRoot: "/", scanned: input.orphaned.length, unreadable: 0, measured: true, orphanedProcesses: input.orphaned }),
    readCmdline: (pid) => input.cmdlines?.[pid] ?? "",
    readCgroup: (pid) => input.cgroups?.[pid] ?? "",
    readMainPid: async (unit) => {
      const values = input.mainPids?.[unit] ?? [];
      const index = reads.get(unit) ?? 0;
      reads.set(unit, index + 1);
      return values[Math.min(index, values.length - 1)] ?? 0;
    },
    stopUnit: async (unit) => { stopped.push(unit); },
  };
}

describe("engine orphan startup hygiene (t-2ea8db)", () => {
  it("stops a proven engine whose workspace cwd was deleted", async () => {
    const unit = "tachyon-engine-0123456789abcdef0123456789abcdef.service";
    const io = adapters({
      orphaned: [{ pid: 41, cwd: "/tmp/gone", command: "tachyon-engine:" }],
      cmdlines: { 41: "tachyon-engine:deadbeef\0" },
      cgroups: { 41: `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n` },
      mainPids: { [unit]: [41, 41] },
    });

    await expect(reapOrphanedEngineDaemons(io)).resolves.toMatchObject({ stopped: [unit], refused: [] });
    expect(io.stopped).toEqual([unit]);
  });

  it("keeps a live workspace engine and refuses a drifting unit identity", async () => {
    const unit = "tachyon-engine-fedcba9876543210fedcba9876543210.service";
    const io = adapters({
      orphaned: [{ pid: 42, cwd: "/tmp/gone", command: "tachyon-engine:" }],
      cmdlines: { 42: "tachyon-engine:deadbeef\0" },
      cgroups: { 42: `0::/user.slice/${unit}\n` },
      mainPids: { [unit]: [42, 99] },
    });

    const report = await reapOrphanedEngineDaemons(io);
    expect(report.stopped).toEqual([]);
    expect(report.refused).toEqual([expect.stringMatching(/identity changed/i)]);
    expect(io.stopped).toEqual([]);
  });
});
