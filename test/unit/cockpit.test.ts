import { describe, expect, it } from "vitest";
import { buildCockpitModel, COCKPIT_SECTION_ORDER, formatCockpitDiagnostics } from "../../src/cockpit/model.js";

describe("cockpit model", () => {
  it("orders sections by ops frequency (no soon slots)", () => {
    expect(COCKPIT_SECTION_ORDER[0]).toBe("overview");
    expect(COCKPIT_SECTION_ORDER[1]).toBe("engine");
    expect(COCKPIT_SECTION_ORDER[2]).toBe("fleet");
    expect(COCKPIT_SECTION_ORDER).toContain("approvals");
    expect(COCKPIT_SECTION_ORDER).toContain("mission");
    expect(COCKPIT_SECTION_ORDER).toContain("validations");
    expect(COCKPIT_SECTION_ORDER.indexOf("validations")).toBeGreaterThan(COCKPIT_SECTION_ORDER.indexOf("mission"));
    expect(COCKPIT_SECTION_ORDER).toContain("worktrees");
    expect(COCKPIT_SECTION_ORDER).toContain("deliveries");
    expect(COCKPIT_SECTION_ORDER).toContain("runtime");
    expect(COCKPIT_SECTION_ORDER).toContain("settings");
  });

  it("builds fleet/worktrees/deliveries overview counts", () => {
    const m = buildCockpitModel(
      [
        {
          control: {
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
            agents: { total: 2, running: 1 },
          },
          agents: [
            { name: "a", running: true },
            { name: "b", running: false },
          ],
          worktrees: [
            { id: "1", kind: "change", path: "/x", branch: "b", status: "active" },
            { id: "2", kind: "change", path: "/y", branch: "c", status: "abandoned" },
          ],
          deliveries: [
            { id: "d1", phase: "open", branchRef: "br" },
            { id: "d2", phase: "pruned", branchRef: "br2" },
          ],
          approvals: [{ id: "a1", status: "pending" }],
          tmux: { state: "healthy", version: "3.4" },
        },
      ],
      { section: "overview", nowIso: "now" },
    );
    expect(m.overview.agentsRunning).toBe(1);
    expect(m.overview.worktreesActive).toBe(1);
    expect(m.overview.deliveriesOpen).toBe(1);
    expect(m.overview.approvalsPending).toBe(1);
    expect(m.fleet).toHaveLength(2);
    expect(m.tmux[0]?.state).toBe("healthy");
  });

  it("formatCockpitDiagnostics is product-oriented", () => {
    const text = formatCockpitDiagnostics(buildCockpitModel([], { nowIso: "now" }));
    expect(text).toMatch(/Control/i);
  });
});
