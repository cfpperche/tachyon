import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EngineLogRing,
  _resetEngineLogRingForTests,
  formatEventsAsLogLines,
  getEngineLogRing,
  installEngineLogRing,
} from "../../src/engine-service/engineLogRing.js";
import { buildControlInspectorModel } from "../../src/control-inspector/model.js";

describe("t-cd3626 engine log ring V1–V2.5", () => {
  afterEach(() => {
    _resetEngineLogRingForTests();
  });

  it("caps lines and stamps levels", () => {
    const ring = new EngineLogRing(3);
    ring.push("a", "I");
    ring.push("b", "W");
    ring.push("c", "E");
    ring.push("d", "I");
    const t = ring.tail();
    expect(t).toHaveLength(3);
    expect(t[0]).toContain(" W b");
    expect(t[2]).toContain(" I d");
    expect(ring.hasError()).toBe(true); // E still in window
  });

  it("hasError when E remains", () => {
    const ring = new EngineLogRing(10);
    ring.push("boom", "E");
    expect(ring.hasError()).toBe(true);
  });

  it("V2.5 hydrates from file and clear truncates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-log-"));
    const file = path.join(dir, "engine.log");
    fs.writeFileSync(file, "2026-07-18T00:00:00.000Z I from-disk\n");
    const ring = new EngineLogRing(50, { filePath: file });
    expect(ring.tail().some((l) => l.includes("from-disk"))).toBe(true);
    ring.push("live", "I");
    expect(fs.readFileSync(file, "utf8")).toContain("live");
    ring.clear();
    expect(ring.tail()).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("install hooks console", () => {
    installEngineLogRing(20);
    console.info("hello-from-test-ring");
    const tail = getEngineLogRing()?.tail() ?? [];
    expect(tail.some((l) => l.includes("hello-from-test-ring"))).toBe(true);
  });

  it("formatEventsAsLogLines", () => {
    const lines = formatEventsAsLogLines([
      { at: "2026-07-18T00:00:00.000Z", kind: "agent.changed", seq: 3, payload: { name: "hermes" } },
    ]);
    expect(lines[0]).toContain("[event#3]");
    expect(lines[0]).toContain("agent.changed");
  });

  it("projects logBySource onto control engine slice", () => {
    const model = buildControlInspectorModel([
      {
        folderName: "tachyon",
        workspaceRoot: "/ws",
        wsHash: "abc",
        bridgeUrl: "http://127.0.0.1:9/mcp",
        identity: {
          pid: 1,
          instanceId: "i",
          processStartIdentity: "p",
          startedAt: "2026-07-18T00:00:00.000Z",
          bundleId: "b",
          engineVersion: "0.56.52",
          protocol: { min: 1, max: 1 },
          bridge: { instanceId: "bi", port: 9 },
        },
        logTail: ["line-one"],
        logBySource: { daemon: ["line-one"], events: ["ev"], bridge: [] },
        logHasError: true,
      },
    ]);
    expect(model.workspaces[0]!.engine.logBySource?.events).toEqual(["ev"]);
    expect(model.workspaces[0]!.engine.logHasError).toBe(true);
  });
});
