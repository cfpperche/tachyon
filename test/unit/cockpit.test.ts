import { describe, expect, it } from "vitest";
import { buildCockpitModel, formatCockpitDiagnostics } from "../../src/cockpit/model.js";

describe("cockpit model (desktop POC)", () => {
  it("builds overview from control plane inputs", () => {
    const m = buildCockpitModel(
      [
        {
          folderName: "tachyon",
          workspaceRoot: "/w",
          wsHash: "abc",
          bridgeUrl: "http://127.0.0.1:7421/mcp",
          identity: {
            pid: 1,
            instanceId: "i",
            processStartIdentity: "p",
            startedAt: "t",
            bundleId: "b",
            engineVersion: "0.1.0",
            bridge: { instanceId: "br", port: 7421 },
          },
          agents: { total: 3, running: 2 },
        },
      ],
      { section: "overview", nowIso: "now" },
    );
    expect(m.framing).toBe("editor-sysadmin");
    expect(m.section).toBe("overview");
    expect(m.overview.enginesAttached).toBe(1);
    expect(m.overview.agentsRunning).toBe(2);
    expect(m.control.workspaces).toHaveLength(1);
  });

  it("formatCockpitDiagnostics mentions cockpit framing", () => {
    const m = buildCockpitModel([], { nowIso: "now" });
    const text = formatCockpitDiagnostics(m);
    expect(text).toMatch(/Cockpit/i);
    expect(text).toMatch(/sidebar/i);
  });
});
