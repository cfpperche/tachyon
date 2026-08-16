import childProcess from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { formatHostLagLog, classifyHostLag } from "../../apps/vscode-extension/src/workspace/hostEventLoopLag.js";
import {
  startHostSyncIoProbe,
  stopHostSyncIoProbe,
  takeHostSyncIoHit,
} from "../../apps/vscode-extension/src/workspace/hostSyncIoProbe.js";

afterEach(() => {
  stopHostSyncIoProbe();
});

describe("t-17674a host sync I/O probe", () => {
  it("names a blocking spawnSync so a late tick can attribute the wait", () => {
    startHostSyncIoProbe();
    takeHostSyncIoHit();
    childProcess.spawnSync("sleep", ["0.2"], { encoding: "utf8" });
    const hit = takeHostSyncIoHit();
    expect(hit).toBeDefined();
    expect(hit!.op).toBe("spawnSync");
    expect(hit!.ms).toBeGreaterThan(150);
    expect(hit!.totalMs).toBeGreaterThan(150);
    expect(hit!.calls).toBeGreaterThanOrEqual(1);
    expect(hit!.path).toBe("sleep");
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
    expect(line).toContain("syncOp=spawnSync");
    expect(line).toMatch(/syncMs=\d+/);
    expect(line).toContain("syncPath=sleep");
  });

  it("forgets the previous interval when take is called", () => {
    startHostSyncIoProbe();
    childProcess.spawnSync("sleep", ["0.2"], { encoding: "utf8" });
    expect(takeHostSyncIoHit()?.op).toBe("spawnSync");
    expect(takeHostSyncIoHit()).toBeUndefined();
  });
});
