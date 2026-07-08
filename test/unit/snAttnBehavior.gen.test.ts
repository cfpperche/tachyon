import { describe, expect, it } from "vitest";
import { AttentionMonitor, PATTERN_STABLE_MS, type AgentAttention, type AttentionSettings } from "../../src/attention/AttentionMonitor.js";

/**
 * t-64f501 — a modal permission prompt was read as "working" because a parallel tool in the
 * same turn kept streaming output, so the pane's full text changed every tick even though the
 * blocking prompt line itself never left the screen. write_input(answering:true) was refused
 * refused-busy repeatedly, and wait_for_agent(until:needs-input) flapped met:true then
 * immediately back to working. The fix: once a recognized needs-input pattern is present in the
 * pane, it wins over content-change/working classification — a modal doesn't stop blocking
 * because some other line scrolled.
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
  );
  return {
    monitor,
    events,
    agents,
    advance: async (ms: number) => {
      now += ms;
      await monitor.tick();
    },
  };
}

describe("container-generated delegation behavior", () => {
  it("a recognized needs-input prompt wins over concurrent content changes in attention classification", async () => {
    const PROMPT_LINE = "Do you want to proceed? 1. Yes 2. Yes, and don't ask again 3. No";
    let step = 0;
    const paneWith = (n: number) => `Searching for 1 pattern, reading 1 file… (${n})\n${PROMPT_LINE}`;

    const f = makeMonitor({ claude: { content: paneWith(step), cpu: 100, settings: SETTINGS } });
    await f.advance(0); // baseline snapshot — the prompt is already visible on first capture

    // A parallel tool keeps streaming output (a different line changes) every tick while the
    // modal prompt line itself never leaves the pane. Before the fix, each of these ticks would
    // read as "activity" and force the pane back to "working".
    for (let i = 0; i < 5; i++) {
      step++;
      f.agents.claude.content = paneWith(step);
      await f.advance(600);
    }
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");
    expect(f.monitor.stateOf("claude")?.matchedLine).toContain("Do you want to proceed?");
    expect(f.events.filter((e) => e.state === "working")).toHaveLength(0);

    // Further concurrent churn with the prompt still present must not flip it back to working.
    step++;
    f.agents.claude.content = paneWith(step);
    await f.advance(600);
    expect(f.monitor.stateOf("claude")?.state).toBe("needs-input");
    expect(f.events.filter((e) => e.state === "working")).toHaveLength(0);

    // Anti-regression (a): once genuinely answered — the pattern is gone from the snapshot —
    // classification must return to working, even while the pane keeps changing.
    f.agents.claude.content = "resuming work...";
    await f.advance(600);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");

    f.agents.claude.content = "resuming work...\nmore output streaming in";
    await f.advance(600);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
  });

  it("pattern-free panes keep existing idle/stall classification unchanged", async () => {
    const f = makeMonitor({ claude: { content: "frozen pane, nothing to see here", cpu: 0, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(SETTINGS.silenceSec * 1000 + 1000); // stable past silenceSec, no prior CPU baseline -> idle
    expect(f.monitor.stateOf("claude")?.state).toBe("idle");

    // Sustained CPU utilization on the same frozen (pattern-free) pane still reads as working,
    // exactly as before this fix.
    f.agents.claude.cpu = 30_000;
    await f.advance(3000);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");

    // And genuine output activity on a pattern-free pane still classifies as working immediately.
    f.agents.claude.content = "frozen pane, nothing to see here\nnow producing output";
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")).toMatchObject({ state: "working" });
  });

  it("a transient pattern-like flicker still needs the debounce window before winning (no misfire on redraw noise)", async () => {
    const f = makeMonitor({ claude: { content: "building...", cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");

    // A prompt-shaped line appears but resolves on its own before PATTERN_STABLE_MS elapses.
    f.agents.claude.content = "Continue? [y/n]";
    await f.advance(PATTERN_STABLE_MS / 2);
    expect(f.monitor.stateOf("claude")?.state).not.toBe("needs-input");

    f.agents.claude.content = "continuing automatically...";
    await f.advance(1000);
    expect(f.monitor.stateOf("claude")?.state).toBe("working");
  });
});
