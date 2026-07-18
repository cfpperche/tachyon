import { afterEach, describe, expect, it } from "vitest";
import {
  EngineLogRing,
  _resetEngineLogRingForTests,
  getEngineLogRing,
  installEngineLogRing,
} from "../../src/engine-service/engineLogRing.js";
import { buildControlInspectorModel } from "../../src/control-inspector/model.js";

describe("t-cd3626 engine log ring V1", () => {
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
  });

  it("install hooks console and exposes via getEngineLogRing", () => {
    const ring = installEngineLogRing(20);
    console.info("hello-from-test-ring");
    const tail = getEngineLogRing()?.tail() ?? [];
    expect(tail.some((l) => l.includes("hello-from-test-ring"))).toBe(true);
    expect(ring.tail().length).toBeGreaterThan(0);
  });

  it("projects logTail onto control engine slice", () => {
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
          engineVersion: "0.56.50",
          protocol: { min: 1, max: 1 },
          bridge: { instanceId: "bi", port: 9 },
        },
        logTail: ["line-one", "line-two"],
      },
    ]);
    expect(model.workspaces[0]!.engine.logTail).toEqual(["line-one", "line-two"]);
  });
});
