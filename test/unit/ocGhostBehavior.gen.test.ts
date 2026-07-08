import { describe, expect, it } from "vitest";
import { AttentionMonitor, PATTERN_STABLE_MS, type AttentionSettings, type AgentAttention } from "../../src/attention/AttentionMonitor.js";

/**
 * t-f1b4ff — ghost-attention regression.
 *
 * Repro (2026-07-08): an ad-hoc child (`cwdProbe`) was killed + its tmux session gone + the
 * agent absent from `list_agents`. The monitor's drop section relies on `runningAgents()`
 * no longer listing the agent; an in-flight needs-input episode left a stale snapshot that kept
 * `needsInputCount() > 0` and re-toasted the coordinator with "child cwdProbe is waiting for
 * input" for several turns past the death. The contract the stub must reach: a removed agent
 * stops emitting needs-input attention — `stateOf` returns undefined, `needsInputCount()`
 * reflects the drop, and no further `onChange` `notify=true` events are emitted for the dead
 * agent across subsequent ticks.
 */
const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };

interface FakeAgent {
  content: string;
  cpu: number | null;
  settings: AttentionSettings;
}

function makeMonitor(agents: Record<string, FakeAgent>) {
  let now = 1_000_000;
  const events: Array<{ agent: string; state: string; notify: boolean; attention: AgentAttention }> = [];
  const monitor = new AttentionMonitor(
    {
      runningAgents: async () => Object.keys(agents),
      capturePane: async (a) => agents[a].content,
      cpuTicks: async (a) => agents[a].cpu,
      settingsOf: (a) => agents[a].settings,
      cmdOf: () => null,
      now: () => now,
    },
    (agent, att: AgentAttention, notify) => events.push({ agent, state: att.state, notify, attention: att }),
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
  it("a removed agent stops emitting needs-input attention", async () => {
    const f = makeMonitor({ cwdProbe: { content: "Continue? [y/n]", cpu: 100, settings: SETTINGS } });

    // Drive the agent into a stable needs-input episode (the precondition of the ghost signal).
    await f.advance(0); // baseline snapshot
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("cwdProbe")?.state).toBe("needs-input");
    expect(f.monitor.needsInputCount()).toBe(1);
    expect(f.events.filter((e) => e.notify)).toHaveLength(1);

    // Repro step 1: kill_agent + tmux session gone + the manager no longer lists cwdProbe.
    // `runningAgents()` is the only source of truth the AttentionMonitor consults each tick —
    // so dropping it from the runtime map simulates exactly "absent from list_agents".
    delete (f.agents as Record<string, FakeAgent>).cwdProbe;
    await f.advance(PATTERN_STABLE_MS + 100); // a full tick past the kill

    // The dropped agent contributes nothing to the public attention API anymore.
    expect(f.monitor.stateOf("cwdProbe")).toBeUndefined();
    expect(f.monitor.needsInputCount()).toBe(0);

    // Repro step 2: subsequent turns must not re-emit a needs-input nudge for the removed agent.
    // The bug filed this exact symptom — the toast kept firing repeatedly across turns past death.
    const eventsAfterKill = f.events.length;
    const notifiesAfterKill = f.events.filter((e) => e.notify).length;
    await f.advance(PATTERN_STABLE_MS + 100);
    await f.advance(PATTERN_STABLE_MS + 100);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.events.slice(eventsAfterKill).filter((e) => e.agent === "cwdProbe")).toHaveLength(0);
    expect(f.events.filter((e) => e.notify).length).toBe(notifiesAfterKill);
    expect(f.monitor.stateOf("cwdProbe")).toBeUndefined();
    expect(f.monitor.needsInputCount()).toBe(0);
  });
});