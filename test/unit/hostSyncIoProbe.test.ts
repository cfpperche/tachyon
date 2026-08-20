import fs from "node:fs";
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

describe("t-17674a host sync I/O probe", () => {
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
