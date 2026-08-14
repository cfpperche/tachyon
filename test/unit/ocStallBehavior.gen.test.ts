import { describe, expect, it } from "vitest";
import {
  AttentionMonitor,
  STALL_AFTER_MS,
  type AgentAttention,
  type AttentionSettings,
} from "@tachyon/shared/attention/AttentionMonitor.js";

/**
 * t-47bfe8 — symphony borrows #2: inactivity-based stall detection.
 *
 * The whole point (study t-dbacb8) is the distinction between wall-clock idle and continuous
 * inactivity. A wall-clock timeout measured from pane start would false-positive on GLM's silent
 * "think" episodes — minute-long gaps that still belong to a working turn (the flicker measured
 * in t-6a5dae). The symphony signal measures elapsed-since-LAST-EVENT: a slow-but-progressing
 * agent keeps moving content and resets the clock every turn, so it never trips; only a genuinely
 * stuck agent (process alive, NO output for the full inactivity window) does.
 *
 * The contract this stub must reach: an idle agent whose pane has been frozen past
 * STALL_AFTER_MS is flagged via AgentAttention.stalled === true and fires onStalled exactly once
 * per episode; a slow-but-progressing agent (which keeps emitting output) is NOT flagged; and the
 * flag clears the moment new output appears.
 */
const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };

interface FakeAgent {
  content: string;
  cpu: number | null;
  settings: AttentionSettings;
}

function makeMonitor(agents: Record<string, FakeAgent>) {
  let now = 1_000_000;
  const events: Array<{ agent: string; state: string; notify: boolean }> = [];
  const stalled: string[] = [];
  const monitor = new AttentionMonitor(
    {
      runningAgents: async () => Object.keys(agents),
      capturePane: async (a) => agents[a].content,
      cpuTicks: async (a) => agents[a].cpu,
      settingsOf: (a) => agents[a].settings,
      cmdOf: () => null,
      now: () => now,
    },
    (agent, att: AgentAttention, notify) => events.push({ agent, state: att.state, notify }),
    undefined,
    (agent) => stalled.push(agent),
  );
  return {
    monitor,
    events,
    agents,
    stalled,
    advance: async (ms: number) => {
      now += ms;
      await monitor.tick();
    },
  };
}

describe("container-generated delegation behavior", () => {
  it("an inactive agent is flagged as stalled after the inactivity window", async () => {
    const f = makeMonitor({ glm: { content: "thinking…", cpu: null, settings: SETTINGS } });

    // Bootstrap snapshot — fresh agent, no stall signal possible.
    await f.advance(0);
    expect(f.monitor.stateOf("glm")?.stalled).toBe(false);
    expect(f.monitor.isStalled("glm")).toBe(false);
    expect(f.monitor.stalledAgents().has("glm")).toBe(false);

    // Cross silenceSec → idle. Short elapsed-since-last-event → NOT stalled yet.
    await f.advance(SETTINGS.silenceSec * 1000 + 100);
    expect(f.monitor.stateOf("glm")?.state).toBe("idle");
    expect(f.monitor.stateOf("glm")?.stalled).toBe(false);
    expect(f.stalled).toHaveLength(0);

    // symphony #2 — a slow-but-progressing agent keeps producing output. Each emission resets
    // contentSince, so elapsed-since-last-event never accumulates past the window. It MUST NOT be
    // flagged, even after a wall-clock time longer than STALL_AFTER_MS in aggregate. This is the
    // exact false-positive a wall-clock timeout would produce on GLM's silent thinks.
    let total = 0;
    for (let i = 0; i < 6; i++) {
      f.agents.glm.content = `still thinking… step ${i}`;
      await f.advance(60_000); // 1 min between emissions — well under STALL_AFTER_MS per gap
      total += 60_000;
    }
    expect(total).toBeGreaterThan(STALL_AFTER_MS); // wall-clock > window, but inactivity is not
    expect(f.monitor.stateOf("glm")?.stalled).toBe(false);
    expect(f.stalled).toHaveLength(0);

    // Now hold the pane genuinely frozen — NO output — past the full inactivity window.
    await f.advance(STALL_AFTER_MS + 1000);
    expect(f.monitor.stateOf("glm")?.stalled).toBe(true);
    expect(f.monitor.isStalled("glm")).toBe(true);
    expect(f.monitor.stalledAgents().has("glm")).toBe(true);
    expect(f.stalled).toEqual(["glm"]); // fired exactly once

    // The signal fires ONCE per episode — subsequent ticks don't re-notify (one-shot, like
    // onCompaction). The flag stays latched true while the agent remains stuck.
    await f.advance(60_000);
    await f.advance(60_000);
    expect(f.stalled).toHaveLength(1);
    expect(f.monitor.stateOf("glm")?.stalled).toBe(true);

    // Rescue: new output clears the flag and re-arms the one-shot for a future episode.
    f.agents.glm.content = "answer ready";
    await f.advance(1000);
    expect(f.monitor.stateOf("glm")?.state).toBe("working");
    expect(f.monitor.stateOf("glm")?.stalled).toBe(false);
    expect(f.monitor.stalledAgents().has("glm")).toBe(false);
  });
});
