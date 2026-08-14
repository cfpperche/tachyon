import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";
import { runtimeProfile } from "@tachyon/shared/runtime/runtimeProfile.js";

/**
 * t-6ffa13 — Tachyon's own delivered notice was read back as a human draft.
 *
 * Reported as "the post-turn suggestion blocks notifications". Measuring the live pane on
 * 2026-07-27 (Claude Code 2.1.220, agent `claude-opus5`) showed the suggestion was NOT the culprit:
 * every suggestion form already classified as empty. What occupied the composer was the runtime's
 * echo of an ALREADY-SUBMITTED message — which, in the incident, was the `[tachyon]` line
 * notify_agent had just delivered.
 *
 * That makes it a loop Tachyon feeds itself: notify_agent submits, the runtime echoes, the echo is
 * read as a draft, and every later notify_agent is queued (Workspace.deliverNotice) while every
 * write_input is refused (`refused-composer`). A quiet pane never leaves the loop, because occupancy
 * is only recomputed when the pane content changes.
 *
 * Every escaped string below is a verbatim `tmux capture-pane -e` line. The discriminator is a
 * measured rendering difference, never the text: the live composer separates `❯` from its content
 * with U+00A0 in EVERY state, while the transcript echo uses an ordinary space.
 */

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 1, patterns: [] };

/** The echo of a submitted message — ordinary space, background colour, no dim. Measured. */
const ECHO_ESCAPED =
  "\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m[tachyon] task t-18f6a5 assigned to you: SDD 478 M4\x1b[39m";
const ECHO_PLAIN = "❯ [tachyon] task t-18f6a5 assigned to you: SDD 478 M4";

/** Post-turn contextual suggestion, in Portuguese — U+00A0 separator, all dim. Measured. */
const SUGGESTION_ESCAPED = "\x1b[39m❯\u00a0\x1b[2mFinalize t-18f6a5 quando o full terminar; permaneça aberto.\x1b[0m";
const SUGGESTION_PLAIN = "❯\u00a0Finalize t-18f6a5 quando o full terminar; permaneça aberto.";

/** Empty composer in the 256-colour theme a harness-spawned agent actually runs. Measured. */
const EMPTY_ESCAPED = "\x1b[38;5;246m❯\u00a0\x1b[39m";
const EMPTY_PLAIN = "❯\u00a0";

/** The incident's own text, typed by a human: U+00A0 separator, no dim. Must keep blocking. */
const DRAFT_ESCAPED = "\x1b[39m❯\u00a0integre em main e verifique o tree";
const DRAFT_PLAIN = "❯\u00a0integre em main e verifique o tree";

/** A realistic tail: transcript, then the echo, then the live composer and its status furniture. */
function paneTail(composerLine: string, opts: { echo?: boolean } = {}): string {
  return [
    "\x1b[38;5;114m●\x1b[39m Done. Created notes.md",
    "",
    ...(opts.echo === false ? [] : [ECHO_ESCAPED]),
    "",
    "\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mCooked for 14s\x1b[39m",
    "\x1b[38;5;37m────────────────────────────────────\x1b[39m",
    composerLine,
    "\x1b[38;5;37m────────────────────────────────────\x1b[39m",
    "\x1b[39m  \x1b[38;5;220m⏵⏵ auto mode on\x1b[39m",
  ].join("\n");
}

function plainOf(escaped: string): string {
  // eslint-disable-next-line no-control-regex
  return escaped.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

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

describe("t-6ffa13 — a submitted-message echo is history, not the composer", () => {
  it("THE MEASURED BUG: Tachyon's own delivered notice no longer occupies the composer", async () => {
    // The echo is the last prompt-glyph line in the window; the live composer did not render one.
    const escaped = [
      "\x1b[38;5;114m●\x1b[39m Done.",
      ECHO_ESCAPED,
      "\x1b[38;5;37m────────────────────────────────────\x1b[39m",
    ].join("\n");

    expect(await composerOccupiedFor("claude", plainOf(escaped), escaped)).toBe(false);
  });

  it("delivers rather than queues once the echo stops counting — the notify path unblocks", async () => {
    // Workspace.deliverNotice queues while composerOccupied is true and submits when it is false;
    // flushQueuedNotice refuses to drain while it is true. One boolean gates the whole notify path,
    // so proving it false for a pane whose tail carries the echo IS the proof notify works again.
    const escaped = paneTail(EMPTY_ESCAPED);

    expect(await composerOccupiedFor("claude", plainOf(escaped), escaped)).toBe(false);
  });

  it("a human draft below the echo still blocks — injection protection is preserved", async () => {
    const escaped = paneTail(DRAFT_ESCAPED);

    expect(await composerOccupiedFor("claude", plainOf(escaped), escaped)).toBe(true);
  });

  it("keeps the post-turn suggestion empty when the echo sits above it", async () => {
    const escaped = paneTail(SUGGESTION_ESCAPED);

    expect(await composerOccupiedFor("claude", plainOf(escaped), escaped)).toBe(false);
  });

  it.each([
    ["the post-turn suggestion alone", SUGGESTION_PLAIN, SUGGESTION_ESCAPED, false],
    ["an empty composer alone", EMPTY_PLAIN, EMPTY_ESCAPED, false],
    ["a typed draft alone", DRAFT_PLAIN, DRAFT_ESCAPED, true],
    ["the echo alone", ECHO_PLAIN, ECHO_ESCAPED, false],
  ] as const)("classifies %s unchanged by the region fix", async (_label, plain, escaped, occupied) => {
    expect(await composerOccupiedFor("claude", plain, escaped)).toBe(occupied);
  });

  it("still blocks on a draft when the escaped capture is unavailable", async () => {
    // The plain fallback has no styling, so it cannot prove a suggestion is dim. It must stay
    // conservative: a draft blocks. The NBSP separator survives ANSI stripping, so the echo is
    // still recognizable as history even here.
    let now = 1_000_000;
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["agent"],
      capturePane: async () => plainOf(paneTail(DRAFT_ESCAPED)),
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

  it("never dismisses an unstyled prompt line as history", async () => {
    // The rule keys on a background colour, so a draft with no styling at all — the shape the
    // cross-runtime behaviour tests use — must keep blocking. Getting this wrong is the permissive
    // direction: a line wrongly called history stops protecting the draft it might really be.
    expect(await composerOccupiedFor("claude", "> existing draft")).toBe(true);
    expect(await composerOccupiedFor("claude", "> ")).toBe(false);
  });

  it("declares the echo rule only where it was measured", () => {
    // Same discipline as ansiEmptyContentStyle: an undeclared runtime keeps today's behaviour.
    expect(runtimeProfile("claude")?.composer?.ansiHistoryEchoStyle).toBe("prompt-background");
    for (const runtime of ["codex", "grok", "opencode", "pi", "hermes"] as const) {
      expect(runtimeProfile(runtime)?.composer?.ansiHistoryEchoStyle).toBeUndefined();
    }
  });

  it("reads a 16-colour and a truecolor background too, but not a malformed one", async () => {
    const glyph = (sgr: string) => `${sgr}❯ \x1b[39m[tachyon] queued notice\x1b[39m`;
    // 16-colour background (SGR 100) and truecolor (48;2;r;g;b) are both real backgrounds.
    for (const sgr of ["\x1b[100m", "\x1b[48;2;40;40;40m"]) {
      expect(await composerOccupiedFor("claude", ECHO_PLAIN, glyph(sgr))).toBe(false);
    }
    // A malformed extended colour claims nothing, so the line keeps protecting its content.
    expect(await composerOccupiedFor("claude", ECHO_PLAIN, glyph("\x1b[48;9m"))).toBe(true);
  });
});
