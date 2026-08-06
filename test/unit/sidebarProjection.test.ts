/**
 * t-a39c7d residual — parseSidebarView Zod must accept AgentStatus including "done".
 * Regression: 0.56.57 emitted done(unseen) without the enum → "Could not refresh Sidebar".
 */
import { describe, expect, it } from "vitest";
import { isSidebarViewV1, parseSidebarViewV1 } from "../../src/runtime-api/sidebarProjection.js";
import { SIDEBAR_FOCUS_FULL_MAX, SIDEBAR_PIN_TEXT_MAX } from "../../src/sidebar/wireText.js";

function minimalFleet(agentStatus: string) {
  return {
    schemaVersion: 1 as const,
    fleet: {
      folder: { hash: "h1", name: "demo" },
      bridge: { port: "1234", connected: true },
      agents: [
        {
          name: "hermes",
          kind: "agent" as const,
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

  it("degrades oversized persisted focus prose without splitting Unicode or rejecting the fleet", () => {
    const input = minimalFleet("running");
    (input.fleet.agents as Array<Record<string, unknown>>)[0] = {
      ...input.fleet.agents[0],
      focus: { text: "long brief", source: "brief", full: `brief ${"😀".repeat(SIDEBAR_FOCUS_FULL_MAX)}` },
    };
    const full = parseSidebarViewV1(input).fleet.agents[0]!.focus!.full;
    expect(full.length).toBeLessThanOrEqual(SIDEBAR_FOCUS_FULL_MAX);
    expect(full).toContain("open the agent for the full brief");
    expect(full).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it("keeps full entity identities while degrading legacy oversized pin prose", () => {
    const input = minimalFleet("running");
    const longName = `agent_${"n".repeat(180)}`;
    input.fleet.agents[0] = { ...input.fleet.agents[0], name: longName };
    (input.fleet.pins as Array<Record<string, unknown>>).push({
      id: "p-abcdef", text: "p".repeat(SIDEBAR_PIN_TEXT_MAX + 1), done: false, tags: [],
    });

    const fleet = parseSidebarViewV1(input).fleet;
    expect(fleet.agents[0]!.name).toBe(longName);
    expect(fleet.pins[0]!.text.length).toBeLessThanOrEqual(SIDEBAR_PIN_TEXT_MAX);
    expect(fleet.pins[0]!.text).toContain("open the pin for full detail");
  });
});
