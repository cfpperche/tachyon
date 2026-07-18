/**
 * t-a39c7d residual — parseSidebarView Zod must accept AgentStatus including "done".
 * Regression: 0.56.57 emitted done(unseen) without the enum → "Could not refresh Sidebar".
 */
import { describe, expect, it } from "vitest";
import { isSidebarViewV1, parseSidebarViewV1 } from "../../src/runtime-api/sidebarProjection.js";

function minimalFleet(agentStatus: string) {
  return {
    schemaVersion: 1 as const,
    fleet: {
      folder: { hash: "h1", name: "demo" },
      bridge: { port: "1234", connected: true },
      agents: [
        {
          name: "hermes",
          status: agentStatus,
        },
      ],
      terminals: [],
      pipelines: [],
      schedules: [],
      commands: [],
      runbooks: [],
      pins: [],
      notices: [],
      proposals: [],
      handoff: { exists: false, staleness: "fresh" as const, pendingCount: 0 },
    },
  };
}

describe("parseSidebarViewV1 agent status enum", () => {
  it("accepts status done (done=unseen idle)", () => {
    const view = parseSidebarViewV1(minimalFleet("done"));
    expect(view.fleet.agents[0]?.status).toBe("done");
    expect(isSidebarViewV1(minimalFleet("done"))).toBe(true);
  });

  it("accepts the full live/stop status set", () => {
    for (const status of [
      "running",
      "needs",
      "throttled",
      "done",
      "idle",
      "stopping",
      "stop-failed",
      "stopped",
      "crashed",
    ] as const) {
      expect(() => parseSidebarViewV1(minimalFleet(status))).not.toThrow();
    }
  });

  it("rejects unknown agent status (fail-closed)", () => {
    expect(isSidebarViewV1(minimalFleet("finished"))).toBe(false);
    expect(() => parseSidebarViewV1(minimalFleet("finished"))).toThrow();
  });
});
