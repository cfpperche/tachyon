import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";
import { runtimeProfile } from "@tachyon/shared/runtime/runtimeProfile.js";

/**
 * t-c5f29b — Claude Code renders a SUGGESTION inside an otherwise empty composer. Tachyon read that
 * suggestion as a human draft and refused continuity with `refused-composer: non-empty composer
 * draft`, while the human had nothing to clear and no key would clear it.
 *
 * Every escaped string below is a verbatim `tmux capture-pane -e` line measured on Claude Code
 * 2.1.220 (2026-07-26). Two details matter and neither is a guess:
 *   - the suggestion's text is SGR 2 (dim); a typed draft carries no dim at all;
 *   - the separator after `❯` is U+00A0 (NBSP), not a space — the same byte in both cases, so it
 *     discriminates nothing and the dim styling is the only real signal.
 *
 * The negative control is the exact text from the incident report, typed for real.
 */

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 1, patterns: [] };

/** Suggestion shown in an empty composer — `❯` default-fg, text dim, reset. */
const CLAUDE_SUGGESTION_ESCAPED = '\x1b[39m❯\u00a0\x1b[2mTry "fix typecheck errors"\x1b[0m';
const CLAUDE_SUGGESTION_PLAIN = '❯\u00a0Try "fix typecheck errors"';

/** The incident's text, actually typed by a human: same prompt, same NBSP, no dim anywhere. */
const CLAUDE_DRAFT_ESCAPED = "\x1b[39m❯\u00a0integre em main e verifique o tree";
const CLAUDE_DRAFT_PLAIN = "❯\u00a0integre em main e verifique o tree";

/** Genuinely empty composer after a completed turn. */
const CLAUDE_EMPTY_ESCAPED = "\x1b[39m❯\u00a0";
const CLAUDE_EMPTY_PLAIN = "❯\u00a0";

async function composerOccupiedFor(cmd: string, plainContent: string, escapedContent = plainContent): Promise<boolean> {
  let now = 1_000_000;
  const monitor = new AttentionMonitor({
    runningAgents: async () => ["agent"],
    capturePane: async () => plainContent,
    capturePaneEscaped: async () => escapedContent,
    cpuTicks: async () => null,
    settingsOf: () => SETTINGS,
    cmdOf: () => cmd,
    now: () => now,
  });
  await monitor.tick();
  now += 1_500;
  await monitor.tick();
  expect(monitor.stateOf("agent")?.state).toBe("idle");
  return monitor.stateOf("agent")?.composerOccupied ?? true;
}

describe("t-c5f29b — a Claude suggestion is not a human draft", () => {
  it("the suggestion does NOT occupy the composer, so continuity is not refused", async () => {
    expect(await composerOccupiedFor("claude", CLAUDE_SUGGESTION_PLAIN, CLAUDE_SUGGESTION_ESCAPED)).toBe(false);
  });

  it("a real typed draft STILL occupies the composer — injection protection is preserved", async () => {
    // Same characters the incident reported, but typed: undimmed, so it must keep blocking.
    expect(await composerOccupiedFor("claude", CLAUDE_DRAFT_PLAIN, CLAUDE_DRAFT_ESCAPED)).toBe(true);
  });

  it("an empty composer is empty", async () => {
    expect(await composerOccupiedFor("claude", CLAUDE_EMPTY_PLAIN, CLAUDE_EMPTY_ESCAPED)).toBe(false);
  });

  it("a draft that merely CONTAINS dim text is still a draft", async () => {
    // Only content that is entirely dim is a suggestion; a human quoting something dim is not.
    const mixed = "\x1b[39m❯\u00a0fix the \x1b[2mdim\x1b[0m parser";
    expect(await composerOccupiedFor("claude", "❯\u00a0fix the dim parser", mixed)).toBe(true);
  });

  it("dim split across separate SGR codes is still a suggestion", async () => {
    const split = '\x1b[39m❯\u00a0\x1b[2m\x1b[3mTry "fix typecheck errors"\x1b[0m';
    expect(await composerOccupiedFor("claude", CLAUDE_SUGGESTION_PLAIN, split)).toBe(false);
  });

  it("falls back to the plain capture when escaped capture is unavailable, and stays conservative", async () => {
    // Without styling there is no way to tell a suggestion from a draft. Refusing to inject is the
    // safe direction: it costs a `notify_agent` fallback, where the opposite would overwrite a human.
    let now = 1_000_000;
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["agent"],
      capturePane: async () => CLAUDE_SUGGESTION_PLAIN,
      capturePaneEscaped: async () => { throw new Error("no escaped capture"); },
      cpuTicks: async () => null,
      settingsOf: () => SETTINGS,
      cmdOf: () => "claude",
      now: () => now,
    });
    await monitor.tick();
    now += 1_500;
    await monitor.tick();
    expect(monitor.stateOf("agent")?.composerOccupied).toBe(true);
  });
});

describe("t-c5f29b — the capability is declared, not inferred", () => {
  it("claude declares the measured all-dim suggestion rule", () => {
    const composer = runtimeProfile("claude")?.composer;
    expect(composer?.ansiEmptyContentStyle).toBe("all-dim");
    expect(composer?.source).toBe("measured");
    expect(composer?.verified).toBe(true);
  });

  it("codex keeps its own measured rule — this change did not disturb the peer", () => {
    expect(runtimeProfile("codex")?.composer?.ansiEmptyContentStyle).toBe("all-dim");
  });

  it("runtimes with an unmeasured composer do NOT claim the rule", () => {
    // Declaring all-dim without measuring it would silently unblock injection on a real draft.
    for (const runtime of ["opencode", "grok", "hermes"] as const) {
      const composer = runtimeProfile(runtime)?.composer;
      if (composer && composer.verified !== true) expect(composer.ansiEmptyContentStyle).toBeUndefined();
    }
  });
});

/**
 * t-6fc817 — Claude's slash-command menu after `/exit` is typed. The prompt sits ABOVE more
 * rows than `composer.tailLines` (8). Same measured shape t-67a565 / t-328cc3 used.
 *
 * The production door is `capturePaneEscaped(agent, composer.tailLines)`: a fake that always
 * returns the whole pane cannot see the miss. Slice to `lines` the way tmux `-S -N` does.
 */
const SLASH_MENU_OVER_EXIT = [
  "\x1b[39m❯\u00a0\x1b[94m/exit\x1b[39m",
  "\x1b[94m/\x1b[1mexit\x1b[22m                         \x1b[1mExit\x1b[22m the CLI\x1b[39m",
  ...Array.from({ length: 16 }, (_, i) => `\x1b[37m/cmd${String(i).padStart(2, "0")}\x1b[31mplaceholder row so the tail misses the prompt\x1b[39m`),
].join("\n");

function tailLinesOf(content: string, lines: number): string {
  return content.split("\n").slice(-lines).join("\n");
}

function monitorHonoringEscapedTail(opts: {
  content: string;
  escaped?: string;
  escapedThrows?: boolean;
  escapedCalls?: number[];
}): AttentionMonitor {
  const escaped = opts.escaped ?? opts.content;
  return new AttentionMonitor({
    runningAgents: async () => ["agent"],
    capturePane: async () => opts.content,
    capturePaneEscaped: async (_agent, lines) => {
      opts.escapedCalls?.push(lines);
      if (opts.escapedThrows) throw new Error("no escaped capture");
      return tailLinesOf(escaped, lines);
    },
    cpuTicks: async () => null,
    settingsOf: () => SETTINGS,
    cmdOf: () => "claude",
    now: () => 1_000_000,
  });
}

describe("t-6fc817 — slash menu taller than the escaped tail is still occupied", () => {
  it("probeComposerOccupied sees /exit under the menu — the fleet write-guard door", async () => {
    const escapedCalls: number[] = [];
    const monitor = monitorHonoringEscapedTail({ content: SLASH_MENU_OVER_EXIT, escapedCalls });
    // Fail-before: the dim-aware probe captures only tailLines (8), the menu is taller, the
    // prompt leaves the capture, and occupancy reads as free — the t-67a565 miss, this door.
    expect(await monitor.probeComposerOccupied("agent")).toBe(true);
    expect(escapedCalls.every((n) => n === runtimeProfile("claude")?.composer?.tailLines)).toBe(true);
  });

  it("the attention tick classifies the same pane as composerOccupied", async () => {
    const monitor = monitorHonoringEscapedTail({ content: SLASH_MENU_OVER_EXIT });
    await monitor.tick();
    expect(monitor.stateOf("agent")?.composerOccupied).toBe(true);
  });

  it("escaped-capture throw still sees /exit — the already-held full pane is enough", async () => {
    const monitor = monitorHonoringEscapedTail({ content: SLASH_MENU_OVER_EXIT, escapedThrows: true });
    expect(await monitor.probeComposerOccupied("agent")).toBe(true);
    await monitor.tick();
    expect(monitor.stateOf("agent")?.composerOccupied).toBe(true);
  });

  it("a history echo in the tail is still empty — the skip is not a slash-menu miss (t-6ffa13)", async () => {
    const echo =
      "\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m[tachyon] task t-18f6a5 assigned to you\x1b[39m";
    const monitor = monitorHonoringEscapedTail({ content: echo });
    expect(await monitor.probeComposerOccupied("agent")).toBe(false);
  });
});
