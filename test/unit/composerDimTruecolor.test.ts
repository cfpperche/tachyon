import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";
import { runtimeProfile } from "@tachyon/shared/runtime/runtimeProfile.js";

/**
 * t-3eaa8b — measuring the peer runtimes' composers turned up a defect in the SHARED dim rule.
 *
 * `ansiEmptyContentStyle: "all-dim"` (t-aee74e codex, t-c5f29b claude) treats composer content that
 * is entirely SGR-dim as a suggestion rather than a human draft. The parser decided "dim" by
 * scanning each escape's parameters as a SET and looking for a 2 — but SGR 38/48/58 introduce an
 * extended colour whose SUB-parameters are ordinary numbers, so truecolor `38;2;r;g;b` contains a
 * literal 2.
 *
 * Measured on grok 0.2.112, whose composer is truecolor: a human's typed draft came out entirely
 * "dim", so the composer read as EMPTY. That is the dangerous direction — an empty composer is what
 * permits injection, so a real draft could have been overwritten. It was latent only because no
 * truecolor runtime declares the rule yet, which is exactly what this task was about to change.
 *
 * The escaped lines below are verbatim `tmux capture-pane -e` captures.
 */

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 1, patterns: [] };

/** grok 0.2.112, human-typed draft. Truecolor throughout; the text carries no dim. */
const GROK_TRUECOLOR_DRAFT_ESCAPED =
  "  \x1b[38;2;80;80;88m│\x1b[38;2;225;225;225m \x1b[38;2;200;200;200m❯ \x1b[38;2;225;225;225mintegre em main e verifique o tree";
const GROK_TRUECOLOR_DRAFT_PLAIN = "  │ ❯ integre em main e verifique o tree";

/** codex placeholder — genuinely dim, and must still read as empty. */
const CODEX_PLACEHOLDER_ESCAPED = "\x1b[1m›\x1b[0m \x1b[2mWrite tests for @filename\x1b[0m";

async function composerOccupied(cmd: string, plain: string, escaped: string): Promise<boolean | undefined> {
  let now = 1_000_000;
  const monitor = new AttentionMonitor({
    runningAgents: async () => ["agent"],
    capturePane: async () => plain,
    capturePaneEscaped: async () => escaped,
    cpuTicks: async () => null,
    settingsOf: () => SETTINGS,
    cmdOf: () => cmd,
    now: () => now,
  });
  await monitor.tick();
  now += 1_500;
  await monitor.tick();
  return monitor.stateOf("agent")?.composerOccupied;
}

describe("t-3eaa8b — extended-colour parameters are not dim", () => {
  it("a truecolor human draft still occupies the composer", async () => {
    // The regression: `38;2;225;225;225` must not be read as SGR 2.
    expect(await composerOccupied("codex", GROK_TRUECOLOR_DRAFT_PLAIN, GROK_TRUECOLOR_DRAFT_ESCAPED)).toBe(true);
  });

  it("a 256-colour human draft still occupies the composer", async () => {
    // `38;5;153` carries a 5 and a 153; neither may flip dim, and the 38 must consume both.
    expect(await composerOccupied("codex", "› hello draft", "\x1b[38;5;153m›\x1b[39m hello draft")).toBe(true);
  });

  it("a genuinely dim placeholder still reads as empty", async () => {
    expect(await composerOccupied("codex", '› Write tests for @filename', CODEX_PLACEHOLDER_ESCAPED)).toBe(false);
  });

  it("dim survives an extended-colour run that follows it", async () => {
    // `2` then a truecolor foreground: the text is still dim, and consuming the colour's
    // sub-parameters must not silently clear that.
    const escaped = "\x1b[1m›\x1b[0m \x1b[2m\x1b[38;2;120;120;120mTry something\x1b[0m";
    expect(await composerOccupied("codex", "› Try something", escaped)).toBe(false);
  });

  it("an explicit 22 after a colour still clears dim", async () => {
    const escaped = "\x1b[1m›\x1b[0m \x1b[2m\x1b[38;5;8mdim\x1b[22m typed\x1b[0m";
    expect(await composerOccupied("codex", "› dim typed", escaped)).toBe(true);
  });

  it("a malformed extended colour fails closed to occupied rather than inventing dim", async () => {
    // `38` with no recognizable mode: stop trusting the rest of that escape instead of guessing.
    expect(await composerOccupied("codex", "› typed", "\x1b[38m›\x1b[39m typed")).toBe(true);
  });
});

describe("t-3eaa8b — peers measured, and none earns the exemption", () => {
  it("only the runtimes with a MEASURED suggestion declare all-dim", () => {
    // grok 0.2.112, opencode 1.18.4/1.18.5, pi 0.80.10 and hermes 0.18.2 were captured with an
    // empty composer, a typed draft and after a completed turn. None renders suggestion text in the
    // composer in any of those states, so none has anything to exempt — declaring the rule for them
    // would be speculative, and it is the declaration that makes content count as "not a draft".
    expect(runtimeProfile("claude")?.composer?.ansiEmptyContentStyle).toBe("all-dim");
    expect(runtimeProfile("codex")?.composer?.ansiEmptyContentStyle).toBe("all-dim");
    for (const runtime of ["grok", "opencode", "pi", "hermes"] as const) {
      expect(runtimeProfile(runtime)?.composer?.ansiEmptyContentStyle).toBeUndefined();
    }
  });
});
