import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";
import { registerTools } from "../../src/bridge/tools.js";
import type { BridgeDeps } from "../../src/bridge/tools/shared.js";

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };

function fixture(credentialState: "live" | "superseded") {
  let now = 1_000_000;
  const monitor = new AttentionMonitor({
    runningAgents: async () => ["claude"],
    capturePane: async () => "turn still visually active",
    cpuTicks: async () => 100,
    settingsOf: () => SETTINGS,
    initialTurnState: () => true,
    now: () => now,
  });
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const mcp = {
    registerTool: (name: string, _definition: unknown, handler: (args: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  };
  registerTools(mcp as never, {
    caller: { kind: "agent", name: "claude", credentialState },
    publishRuntimeStatus: (agent: string, event: "stopped") => monitor.publishRuntimeStatus(agent, event),
  } as unknown as BridgeDeps);
  return {
    monitor,
    tick: () => monitor.tick(),
    publish: () => handlers.get("runtime_status_publish")?.({ event: "stopped", runtime: "claude" }),
    advance: (ms: number) => { now += ms; },
  };
}

describe("native runtime status attention ingest", () => {
  it("t-6b3a0d: a native stop moves attention idle without the 8s pane timer", async () => {
    const f = fixture("live");
    await f.tick();
    expect(f.monitor.stateOf("claude")?.state).toBe("working");

    await f.publish();

    expect(f.monitor.stateOf("claude")).toMatchObject({ state: "idle", unseen: true });
  });

  it("t-6b3a0d: a stop from the previous session cannot change the current session", async () => {
    const f = fixture("superseded");
    await f.tick();

    const receipt = await f.publish();

    expect(receipt).toMatchObject({ isError: true });
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
  });
});
