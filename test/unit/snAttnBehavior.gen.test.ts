import { describe, expect, it } from "vitest";
import {
  AttentionMonitor,
  PATTERN_STABLE_MS,
  THROTTLE_NOTIFY_DELAY_MS,
  type AgentAttention,
  type AttentionSettings,
} from "@tachyon/shared/attention/AttentionMonitor.js";

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

  // Review follow-up (t-64f501, empirically reproduced against the shipped commit before these
  // fixes): the matchSince/matchKey mechanism above traded one false-negative bug for three real
  // defects, all stemming from using raw pane-text equality as a stability proxy. Each case below
  // reproduces exactly the scenario that failed pre-fix.
  it("a live countdown embedded in the matched throttle line still classifies throttled after the debounce (HIGH: matchKey keys on the matched PATTERN, not the matched line's text)", async () => {
    let secondsLeft = 45;
    const paneWith = () => `Usage limit reached, try again in ${secondsLeft}s`;

    const f = makeMonitor({ claude: { content: paneWith(), cpu: 100, settings: SETTINGS } });
    await f.advance(0); // baseline snapshot — the throttle banner is already visible

    // The countdown ticks every second, so the matched line's exact text differs on every single
    // tick. Pre-fix, matchKey was the literal matched line: matchKey !== match.line was true every
    // tick, matchSince reset to `now` every tick, matchStableMs never reached PATTERN_STABLE_MS,
    // and the pane stayed "working" forever — never throttled, no parent poke, write_input's busy
    // check never released. The fix keys matchKey on match.pattern (the source regex), which is
    // identical every tick regardless of the countdown digits, so stability accumulates normally.
    for (let i = 0; i < 3; i++) {
      secondsLeft--;
      f.agents.claude.content = paneWith();
      await f.advance(1000);
    }
    expect(f.monitor.stateOf("claude")?.state).toBe("throttled");
    expect(f.monitor.stateOf("claude")?.matchedLine).toContain("try again in");
  });

  it("a sustained throttle notifies exactly once even while unrelated pane churn continues (MEDIUM: throttle-notify one-shot keys on matchSince, not contentSince)", async () => {
    const THROTTLE_LINE = "overloaded, retrying...";
    let tick = 0;
    // The throttle line itself never changes — only an unrelated line above it (a parallel tool
    // still streaming output) churns every tick. This isolates the anti-spam bug from the HIGH
    // countdown scenario above.
    const paneWith = () => `tool output tick ${tick}\n${THROTTLE_LINE}`;

    const f = makeMonitor({ claude: { content: paneWith(), cpu: 100, settings: SETTINGS } });
    await f.advance(0);
    await f.advance(PATTERN_STABLE_MS + 100);
    expect(f.monitor.stateOf("claude")?.state).toBe("throttled");
    expect(f.events.filter((e) => e.notify)).toHaveLength(0);

    // Sustained churn well past THROTTLE_NOTIFY_DELAY_MS. Pre-fix, notifiedEpisode was keyed on
    // snap.contentSince, which is bumped to `now` on every churn tick (contentChanged is true even
    // though the throttle itself never wavers) — so `notifiedEpisode !== snap.contentSince` was
    // true again on every tick past the delay, re-firing the toast every ~5s instead of once per
    // episode. The fix keys notifiedEpisode on snap.matchSince, which only moves when the matched
    // pattern itself changes or disappears — unaffected by unrelated churn.
    let elapsed = PATTERN_STABLE_MS + 100;
    while (elapsed < THROTTLE_NOTIFY_DELAY_MS + 10_000) {
      tick++;
      f.agents.claude.content = paneWith();
      await f.advance(5000);
      elapsed += 5000;
    }
    expect(f.monitor.stateOf("claude")?.state).toBe("throttled");
    expect(f.events.filter((e) => e.notify)).toHaveLength(1);
  });

  it("prompt-shaped text a few lines up in genuinely-progressing output never wins precedence (MEDIUM: a match must sit near the bottom of the tail to win)", async () => {
    const FIXTURE_LINE = 'test: prints fixture "Do you want to proceed? [y/n]" for coverage';
    const lines = [FIXTURE_LINE];

    const f = makeMonitor({ claude: { content: lines.join("\n"), cpu: 100, settings: SETTINGS } });
    await f.advance(0); // baseline — the fixture line sits alone, matched at the bottom

    // A real test runner keeps producing new, unrelated output roughly every 700ms — genuinely
    // active the entire time. FIXTURE_LINE merely echoes prompt-shaped text as a coverage string;
    // nothing is actually blocked. Pre-fix (bar was only "still within the 8-line tail window"),
    // by the 4th new line (~2.8s, still well inside TAIL_WINDOW) matchStableMs crossed
    // PATTERN_STABLE_MS and the pane misclassified as needs-input even though output never
    // stopped landing. The fix additionally requires the match sit within
    // PATTERN_POSITION_TOLERANCE lines of the bottom — FIXTURE_LINE scrolls out of that range by
    // the 4th appended line, well before it scrolls out of the tail window entirely.
    for (let i = 1; i <= 6; i++) {
      lines.push(`test ${i}: pass`);
      f.agents.claude.content = lines.join("\n");
      await f.advance(700);
      expect(f.monitor.stateOf("claude")?.state).toBe("working");
    }
    expect(f.events.filter((e) => e.state === "needs-input")).toHaveLength(0);
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
