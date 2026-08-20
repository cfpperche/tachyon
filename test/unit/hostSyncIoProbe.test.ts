import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFromOwnerA } from "../fixtures/host-sync-io-owner-a/reader.js";
import { readFromOwnerB } from "../fixtures/host-sync-io-owner-b/reader.js";
import {
  formatHostLagLog,
  classifyHostLag,
  readLinuxRunDelayMs,
} from "../../apps/vscode-extension/src/workspace/hostEventLoopLag.js";
import {
  startHostSyncIoProbe,
  stopHostSyncIoProbe,
  takeHostSyncIoHit,
} from "../../apps/vscode-extension/src/workspace/hostSyncIoProbe.js";

afterEach(() => {
  stopHostSyncIoProbe();
});

const FS_OPS = new Set(["readFileSync", "readdirSync", "readSync"]);

const NEW_SYNC_DOORS = [
  { op: "mkdirSync", run: (target: string) => fs.mkdirSync(target) },
  { op: "writeFileSync", run: (target: string) => fs.writeFileSync(target, "probe\n") },
  { op: "statSync", run: (target: string) => fs.statSync(target) },
  { op: "renameSync", run: (target: string) => fs.renameSync(target, `${target}.renamed`) },
  { op: "appendFileSync", run: (target: string) => fs.appendFileSync(target, "probe\n") },
  { op: "spawnSync", run: (target: string) => spawnSync(target, ["-e", ""]) },
  { op: "execFileSync", run: (target: string) => execFileSync(target, ["-e", ""]) },
] as const;

describe("t-17674a host sync I/O probe", () => {
  it.each(NEW_SYNC_DOORS)("reports $op with its caller site and target path", ({ op, run }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t-8a9337-probe-"));
    const target = op === "spawnSync" || op === "execFileSync"
      ? process.execPath
      : path.join(root, op === "mkdirSync" ? "created" : "target");
    if (!["mkdirSync", "writeFileSync", "spawnSync", "execFileSync"].includes(op)) {
      fs.writeFileSync(target, "seed\n");
    }
    try {
      startHostSyncIoProbe();
      takeHostSyncIoHit();

      run(target);

      const hit = takeHostSyncIoHit();
      expect(hit?.op).toBe(op);
      expect(hit?.site).toContain("hostSyncIoProbe.test.ts");
      expect(hit?.path).toBe(target);
      const line = formatHostLagLog(classifyHostLag({
        wallLagMs: 5001,
        hrLagMs: 5001,
        eluActiveMs: 5000,
        eluIdleMs: 100,
        cpuMs: 20,
        loadavg1: 1,
        cpuCount: 24,
        runDelayMs: 0,
      }), hit);
      expect(line).toContain(`syncSite=${hit!.site}`);
      expect(line).toContain(`syncPath=${target}`);
    } finally {
      stopHostSyncIoProbe();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a blocking readFileSync so a late tick can attribute the wait", () => {
    const file = path.join(os.tmpdir(), `t-17674a-probe-${process.pid}.txt`);
    fs.writeFileSync(file, "probe\n");
    try {
      startHostSyncIoProbe();
      takeHostSyncIoHit();
      fs.readFileSync(file, "utf8");
      const hit = takeHostSyncIoHit();
      expect(hit).toBeDefined();
      expect(FS_OPS.has(hit!.op)).toBe(true);
      expect(hit!.calls).toBeGreaterThanOrEqual(1);
      expect(hit!.totalMs).toBeGreaterThan(0);
      expect(hit!.site).toBeDefined();
      expect(hit!.site).not.toMatch(/^hostEventLoopLag\.ts:/);
      expect(hit!.path).toBe(file);
      const sample = classifyHostLag({
        wallLagMs: 5001,
        hrLagMs: 5001,
        eluActiveMs: 5000,
        eluIdleMs: 100,
        cpuMs: 20,
        loadavg1: 1,
        cpuCount: 24,
        runDelayMs: 0,
      });
      expect(sample.cause).toBe("sync-work");
      const line = formatHostLagLog(sample, hit);
      expect(line).toContain(`syncOp=${hit!.op}`);
      expect(line).toMatch(/syncMs=\d+/);
      expect(line).toMatch(/syncTotalMs=\d+/);
      expect(line).toMatch(/syncCalls=\d+/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("does not attribute the detector's own synchronous schedstat read", () => {
    startHostSyncIoProbe();
    takeHostSyncIoHit();

    readLinuxRunDelayMs();

    expect(takeHostSyncIoHit()).toBeUndefined();
  });

  it("keeps enough caller path to distinguish different extension owners", () => {
    const file = path.join(os.tmpdir(), `t-17674a-owners-${process.pid}.txt`);
    fs.writeFileSync(file, "probe\n");
    try {
      startHostSyncIoProbe();
      takeHostSyncIoHit();

      readFromOwnerA(file);
      const first = takeHostSyncIoHit();
      readFromOwnerB(file);
      const second = takeHostSyncIoHit();

      expect(first?.site).toBeDefined();
      expect(second?.site).toBeDefined();
      expect(first?.site).not.toBe(second?.site);
      expect(first?.site).toContain("host-sync-io-owner-a/reader.ts");
      expect(second?.site).toContain("host-sync-io-owner-b/reader.ts");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

});
