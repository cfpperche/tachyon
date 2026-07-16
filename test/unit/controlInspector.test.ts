import { describe, expect, it } from "vitest";
import {
  buildControlInspectorModel,
  formatControlInspectorDiagnostics,
  parseBridgePort,
} from "../../src/control-inspector/model.js";

describe("control inspector model (POC)", () => {
  it("parseBridgePort reads host:port URLs", () => {
    expect(parseBridgePort("http://127.0.0.1:7421/mcp")).toBe(7421);
    expect(parseBridgePort("not-a-url")).toBeUndefined();
  });

  it("builds summary from attached / error / none workspaces", () => {
    const model = buildControlInspectorModel(
      [
        {
          folderName: "tachyon",
          workspaceRoot: "/home/u/tachyon",
          wsHash: "abc123",
          bridgeUrl: "http://127.0.0.1:7421/mcp",
          identity: {
            pid: 4242,
            instanceId: "eng-1",
            processStartIdentity: "start-1",
            startedAt: "2026-07-16T12:00:00.000Z",
            bundleId: "bundle-1",
            engineVersion: "0.56.10",
            protocol: { min: 3, max: 3 },
            bridge: { instanceId: "br-1", port: 7421 },
          },
          agents: { total: 5, running: 3 },
          authConfigured: true,
        },
        {
          folderName: "broken",
          workspaceRoot: "/tmp/x",
          wsHash: "dead00",
          bridgeUrl: "http://127.0.0.1:9/mcp",
          identityError: "control socket refused",
        },
        {
          folderName: "idle",
          workspaceRoot: "/tmp/y",
          wsHash: "idle01",
          bridgeUrl: "http://127.0.0.1:8/mcp",
          identity: null,
        },
      ],
      "2026-07-16T17:00:00.000Z",
    );

    expect(model.poc).toBe(true);
    expect(model.summary).toEqual({
      workspaceCount: 3,
      attachedEngines: 1,
      engineErrors: 1,
      totalAgents: 5,
      runningAgents: 3,
    });
    expect(model.workspaces[0]?.engine.state).toBe("attached");
    expect(model.workspaces[0]?.bridge.port).toBe(7421);
    expect(model.workspaces[1]?.engine.state).toBe("error");
    expect(model.workspaces[2]?.engine.state).toBe("none");
    expect(model.workspaces[2]?.notes.some((n) => /not attached/i.test(n))).toBe(true);
  });

  it("formatControlInspectorDiagnostics is secret-free and stable-ish", () => {
    const model = buildControlInspectorModel(
      [
        {
          folderName: "tachyon",
          workspaceRoot: "/home/u/tachyon",
          wsHash: "abc123",
          bridgeUrl: "http://127.0.0.1:7421/mcp",
          identity: {
            pid: 1,
            instanceId: "i",
            processStartIdentity: "p",
            startedAt: "t",
            bundleId: "b",
            engineVersion: "0.1.0",
          },
        },
      ],
      "now",
    );
    const text = formatControlInspectorDiagnostics(model);
    expect(text).toContain("Engine/Bridge Inspector");
    expect(text).toContain("pid=1");
    expect(text).not.toMatch(/Bearer|token|secret/i);
  });
});
