/**
 * t-a39c7d residual — parseSidebarView Zod must accept AgentStatus including "done".
 * Regression: 0.56.57 emitted done(unseen) without the enum → "Could not refresh Sidebar".
 */
import { describe, expect, it } from "vitest";
import { isSidebarViewV1, parseSidebarViewV1 } from "@tachyon/engine/runtime-api/sidebarProjection.js";
import { SIDEBAR_FOCUS_FULL_MAX, SIDEBAR_PIN_TEXT_MAX } from "@tachyon/engine/sidebar/wireText.js";

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

  it("t-0c7049: empty persistenceHooks.path does not refuse the fleet", () => {
    // Owner status bar: fleet.agents[0].persistenceHooks.path is too_small.
    // The Stop hook logged path:"" (the empty TACHYON_AGENT_BRIDGE_URL). An optional
    // field filled with "" is absence, not a catastrophe. This test is the red proof:
    // if parse throws / isSidebarViewV1 is false, the whole sidebar stays blank.
    const input = minimalFleet("running");
    (input.fleet.agents as Array<Record<string, unknown>>)[0] = {
      ...input.fleet.agents[0],
      persistenceHooks: {
        state: "failed",
        reason: "runtime status hook environment is incomplete",
        path: "",
      },
    };
    const view = parseSidebarViewV1(input);
    expect(view.fleet.agents).toHaveLength(1);
    expect(view.fleet.agents[0]?.persistenceHooks?.state).toBe("failed");
    expect(view.fleet.agents[0]?.persistenceHooks?.path).toBeUndefined();
    expect(isSidebarViewV1(input)).toBe(true);
  });

  it("rejects unknown agent status (fail-closed)", () => {
    expect(isSidebarViewV1(minimalFleet("finished"))).toBe(false);
    expect(() => parseSidebarViewV1(minimalFleet("finished"))).toThrow();
  });

  it("t-195a6c: accepts taskStatus on a task focus without refusing the fleet", () => {
    const input = minimalFleet("running");
    (input.fleet.agents as Array<Record<string, unknown>>)[0] = {
      ...input.fleet.agents[0],
      focus: {
        text: "Registrar o processo",
        source: "task",
        taskId: "t-b928fc",
        taskStatus: "triaged",
        full: "t-b928fc  Registrar o processo",
      },
    };
    const view = parseSidebarViewV1(input);
    expect(view.fleet.agents[0]?.focus?.taskStatus).toBe("triaged");
    expect(view.fleet.agents[0]?.focus?.taskId).toBe("t-b928fc");
    expect(isSidebarViewV1(input)).toBe(true);
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
