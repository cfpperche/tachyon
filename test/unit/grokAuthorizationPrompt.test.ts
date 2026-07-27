import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "../../src/attention/AttentionMonitor.js";
import { classifyAttentionTail } from "../../src/attention/patterns.js";

/**
 * t-4e6ba5 — Grok's native tool-authorization prompt left the agent classified `working`: no
 * coordinator notification, and governed input refused as busy, so the only way through was polling
 * and typing straight into tmux.
 *
 * The pane below is a verbatim capture from grok 0.2.112 (2026-07-26), produced by asking a real
 * agent under `--permission-mode default` to delete a file OUTSIDE its workspace. Two measured facts
 * shape the fix:
 *
 *  1. Nothing in the base manifest matches this chrome. It has no `[y/n]`, no "do you want to", and
 *     the numbered options are `1 (●)` — no period — so the base `❯\s*\d+\.` menu rule misses them.
 *  2. The pane KEEPS CHANGING while the prompt waits: an elapsed-time counter ticks every second.
 *     That is why it read as `working` — and why the rule must match near the BOTTOM, where
 *     `classifyForPrecedence` lets a recognized prompt beat content-change classification.
 *
 * On a FIRST prompt option 1 is pre-selected and option 1 is `always-approve`. On a second prompt the
 * selection has moved to whatever was chosen last (measured: `2 (●)` after answering `2`). So the
 * highlighted option is session state, not a constant — a bare Enter grants an unpredictable answer
 * that may be blanket approval. Nothing here may answer on its own; the one-time grant is an
 * explicit `2`, which was verified NOT to enable always-approve (the next out-of-workspace action
 * prompted again).
 */

const GROK_AUTH_PROMPT = [
  "  ┃  Remove target.txt from /tmp/grok-outside",
  "  ┃  rm -f /tmp/grok-outside/target.txt",
  "  ┃",
  "  ┃  1 (●) Yes, and don't ask again for anything (always-approve mode)",
  "  ┃  2 (○) Yes, proceed",
  "  ┃  3 (○) No, reject (type to add feedback)",
  "  ┃",
  "  1/3:select  │  Ctrl+o:always-approve  │  Ctrl+c:cancel",
].join("\n");

/** The same pane one second later — only the elapsed counter moved. */
const GROK_AUTH_PROMPT_TICKED = [
  "    \u25c6 Remove target.txt from /tmp/grok-outside\u2026 47s                    52s \u21e314.8k [\u2193][stop]",
  GROK_AUTH_PROMPT,
].join("\n");

/** An ordinary idle Grok pane: composer plus its normal footer. */
const GROK_IDLE = [
  "  Tip: Run /compact [context] when chat gets long.",
  "  ╭────────────────────────────────────────────╮",
  "  │ ❯                                          │",
  "  ╰──────────────── Grok 4.5 (high) ───────────╯",
  "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
].join("\n");

/** A Grok pane mid-turn with no prompt: the same ticking counter, no options. */
const GROK_WORKING = [
  "    ◆ Remove target.txt from /tmp/grok-outside… 41s                    46s ⇣14.8k [↓][stop]",
  "  ╭────────────────────────────────────────────╮",
  "  │ ❯                                          │",
  "  ╰──────────────── Grok 4.5 (high) ───────────╯",
  "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
].join("\n");

/** The SECOND prompt in the same session: the radio has moved to the previously chosen option. */
const GROK_AUTH_PROMPT_SECOND = [
  "  ┃  Remove second.txt from /tmp/grok-outside",
  "  ┃  rm -f /tmp/grok-outside/second.txt",
  "  ┃",
  "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
  "  ┃  2 (●) Yes, proceed",
  "  ┃  3 (○) No, reject (type to add feedback)",
  "  ┃",
  "  1/3:select  │  Ctrl+o:always-approve  │  Ctrl+c:cancel",
].join("\n");

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 1, patterns: [] };

describe("t-4e6ba5 — Grok tool-authorization prompt is recognized", () => {
  it("classifies the measured prompt as needs-input", () => {
    const match = classifyAttentionTail(GROK_AUTH_PROMPT, [], "grok");
    expect(match?.kind).toBe("prompt");
  });

  it("matches near the bottom, so it can beat the still-ticking turn counter", () => {
    // classifyForPrecedence requires distanceFromBottom <= PATTERN_POSITION_TOLERANCE (3). The
    // first option line sits 4 non-empty lines up, so a rule that only matched option 1 would be
    // rejected exactly when it matters most.
    const match = classifyAttentionTail(GROK_AUTH_PROMPT, [], "grok");
    expect(match?.distanceFromBottom).toBeLessThanOrEqual(3);
  });

  it("recognizes the prompt whichever option happens to be highlighted", () => {
    // The radio remembers the last answer, so detection must not depend on option 1 being selected.
    expect(classifyAttentionTail(GROK_AUTH_PROMPT_SECOND, [], "grok")?.kind).toBe("prompt");
  });

  it("does not fire on an idle pane or on a working turn without a prompt", () => {
    expect(classifyAttentionTail(GROK_IDLE, [], "grok")?.kind).not.toBe("prompt");
    expect(classifyAttentionTail(GROK_WORKING, [], "grok")?.kind).not.toBe("prompt");
  });

  it("does not change how the other runtimes read the same text", () => {
    // The rule is a measured Grok overlay; peers must not inherit it by accident.
    for (const runtime of ["claude", "codex", "opencode", "pi"] as const) {
      expect(classifyAttentionTail(GROK_AUTH_PROMPT, [], runtime)?.kind).not.toBe("prompt");
    }
  });
});

describe("t-4e6ba5 — the monitor surfaces it despite the ticking counter", () => {
  async function stateFor(panes: string[]): Promise<{ state?: string; matched?: string }> {
    let now = 1_000_000;
    let index = 0;
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["grokker"],
      capturePane: async () => panes[Math.min(index, panes.length - 1)]!,
      cpuTicks: async () => null,
      settingsOf: () => SETTINGS,
      cmdOf: () => "grok",
      now: () => now,
    });
    for (const _ of panes) {
      await monitor.tick();
      index++;
      now += 1_500; // PATTERN_STABLE_MS is 2500, so three ticks clear the debounce window
    }
    const snap = monitor.stateOf("grokker");
    return { state: snap?.state, matched: snap?.matchedLine };
  }

  it("reaches needs-input while the pane is still changing", async () => {
    // Three ticks of a pane whose counter keeps moving: content-change alone would say `working`
    // forever, which is exactly what the incident reported.
    const result = await stateFor([GROK_AUTH_PROMPT, GROK_AUTH_PROMPT_TICKED, GROK_AUTH_PROMPT]);
    expect(result.state).toBe("needs-input");
    expect(result.matched).toBeTruthy();
  });

  it("a working turn with no prompt stays working", async () => {
    // Every tick shows a moved counter and no prompt — content change alone, which is `working`.
    const result = await stateFor([
      GROK_WORKING,
      GROK_WORKING.replace("41s", "47s"),
      GROK_WORKING.replace("41s", "53s"),
    ]);
    expect(result.state).toBe("working");
  });

  it("returns to working once the prompt is answered and the turn resumes", async () => {
    let now = 1_000_000;
    let pane = GROK_AUTH_PROMPT;
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["grokker"],
      capturePane: async () => pane,
      cpuTicks: async () => null,
      settingsOf: () => SETTINGS,
      cmdOf: () => "grok",
      now: () => now,
    });
    for (let i = 0; i < 3; i++) { await monitor.tick(); now += 1_500; }
    expect(monitor.stateOf("grokker")?.state).toBe("needs-input");

    // The coordinator answers "2" (the one-time grant); the modal goes and the turn resumes, with
    // the same counter still ticking — so the pane keeps changing, as it does on a real agent.
    pane = GROK_WORKING;
    await monitor.tick();
    now += 1_500;
    pane = GROK_WORKING.replace("41s", "47s");
    await monitor.tick();
    expect(monitor.stateOf("grokker")?.state).toBe("working");
  });
});

describe("t-4e6ba5 — always-approve is never chosen for anyone", () => {
  it("a first prompt highlights always-approve, so a bare Enter would grant it", () => {
    const preselected = GROK_AUTH_PROMPT.split("\n").find((line) => line.includes("(●)"));
    expect(preselected).toContain("always-approve");
    expect(preselected).toMatch(/^\s*┃\s*1\b/);
  });

  it("the highlight is session state, not a constant — so an answer must always name its option", () => {
    // Measured: after answering `2`, the next prompt arrives with `2 (●)`. Anything that answered by
    // pressing Enter would therefore send a different decision depending on history, and on a first
    // prompt that decision is blanket approval.
    const second = GROK_AUTH_PROMPT_SECOND.split("\n").find((line) => line.includes("(●)"));
    expect(second).toContain("Yes, proceed");
    expect(second).not.toContain("always-approve");
  });

  it("Tachyon ships no path that answers an authorization prompt by itself", async () => {
    // The monitor observes and notifies; it must never write to the pane. If this ever fails, an
    // auto-answer was introduced and it would land on the pre-selected always-approve option.
    let wrote = 0;
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["grokker"],
      capturePane: async () => { return GROK_AUTH_PROMPT; },
      cpuTicks: async () => null,
      settingsOf: () => SETTINGS,
      cmdOf: () => "grok",
      now: () => 1_000_000,
      // Any write-shaped seam the monitor might gain would have to come through its IO surface.
      ...({ sendKeys: () => { wrote++; }, writeInput: () => { wrote++; } } as Record<string, unknown>),
    });
    await monitor.tick();
    await monitor.tick();
    expect(wrote).toBe(0);
  });
});
