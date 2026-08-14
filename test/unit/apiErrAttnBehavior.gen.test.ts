import { describe, expect, it } from "vitest";
import { AttentionMonitor, PATTERN_STABLE_MS, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";
import { classifyAttentionTail } from "@tachyon/shared/attention/patterns.js";

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };

describe("container-generated delegation behavior", () => {
  it("pane runtime errors surface as an attention state", async () => {
    let now = 1_000_000;
    const pane = "API Error: 500 Internal server error";
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["claude"],
      capturePane: async () => pane,
      cpuTicks: async () => 100,
      settingsOf: () => SETTINGS,
      cmdOf: () => "claude",
      now: () => now,
    });

    expect(classifyAttentionTail(pane)).toMatchObject({ kind: "error", line: pane });

    await monitor.tick();
    now += PATTERN_STABLE_MS + 100;
    await monitor.tick();

    expect(monitor.stateOf("claude")).toMatchObject({
      state: "throttled",
      matchedLine: pane,
    });
  });
});
