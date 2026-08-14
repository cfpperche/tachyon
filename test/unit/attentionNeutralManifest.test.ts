import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";
import { evaluateAttentionManifest } from "@tachyon/shared/attention/manifestEngine.js";
import { attentionManifestForRuntime, BASE_MANIFEST, NEUTRAL_OVERLAY } from "@tachyon/shared/attention/manifests.js";
import { classifyAttentionTail } from "@tachyon/shared/attention/patterns.js";

/**
 * t-c59600 — an entry that declares NO runtime is classified against a NEUTRAL set, never against
 * Claude's by accident of a default parameter.
 *
 * The production door is a `kind: terminal` entry: `Workspace.settingsOf` turns attention on for it
 * whenever the human declared it, while `cmdOf` returns null by design (Workspace.ts:1468, spec 216
 * — terminals must never enqueue a re-anchor). AttentionMonitor.manifestRuntimeFromCmd turns that
 * null into `undefined`, and `undefined` used to mean "claude". These tests drive that whole door,
 * not just the pure classifier.
 */

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };
const ATTENTION_POLL_MS = 3000;

/** Runs a pane through the real monitor as a TERMINAL (cmdOf → null, exactly like Workspace). */
async function terminalState(content: string): Promise<{ state?: string; matchedLine?: string }> {
  let now = 1_000_000;
  const mon = new AttentionMonitor({
    runningAgents: async () => ["build"],
    capturePane: async () => content,
    capturePaneEscaped: async () => content,
    cpuTicks: async () => 0,
    settingsOf: () => SETTINGS,
    // The measured terminal path: Workspace returns null for kind !== "agent".
    cmdOf: () => null,
    now: () => now,
  } as never);
  for (let i = 0; i < 8; i++) {
    await mon.tick();
    now += ATTENTION_POLL_MS;
  }
  const s = mon.stateOf("build");
  return { state: s?.state, matchedLine: s?.matchedLine };
}

describe("t-c59600 — a runtime-less entry resolves the neutral manifest", () => {
  it("no runtime declared resolves `neutral`, not `claude`", () => {
    expect(attentionManifestForRuntime(undefined).runtime).toBe("neutral");
    // `cmdOf` returns null and manifestRuntimeFromCmd returns undefined — both spellings of
    // "nothing declared" must land on the same manifest.
    expect(attentionManifestForRuntime(null).runtime).toBe("neutral");
    expect(attentionManifestForRuntime("claude").runtime).toBe("claude");
  });

  it("neutral is not reachable by a runtime overlay lookup", () => {
    // The leak this task exists to close: the day a measured `claude.json` overlay lands, a
    // terminal must NOT inherit it. Neutral resolves BASE + the neutral overlay and nothing else,
    // so its rule ids are exactly that union — no runtime overlay id can appear here.
    const neutral = attentionManifestForRuntime(undefined);
    const expected = new Set([...BASE_MANIFEST.rules.map((r) => r.id), ...NEUTRAL_OVERLAY.rules.map((r) => r.id)]);
    expect(new Set(neutral.rules.map((r) => r.id))).toEqual(expected);
    // grok is the one runtime with a shipped overlay today; it must stay confined to grok.
    const grokOnly = attentionManifestForRuntime("grok").rules.map((r) => r.id).filter((id) => !expected.has(id));
    expect(grokOnly.length).toBeGreaterThan(0);
    for (const id of grokOnly) expect(neutral.rules.map((r) => r.id)).not.toContain(id);
  });

  it("neutral rules stay out of every DECLARED runtime's manifest", () => {
    const neutralOnly = NEUTRAL_OVERLAY.rules.map((r) => r.id);
    for (const runtime of ["claude", "codex", "grok", "opencode", "gemini"] as const) {
      const ids = attentionManifestForRuntime(runtime).rules.map((r) => r.id);
      for (const id of neutralOnly) expect(ids).not.toContain(id);
    }
  });
});

/**
 * "Measure what you LOSE." Neutral EXTENDS base rather than replacing it, and this is the guard
 * that keeps it that way: every base rule was checked against a real terminal corpus and each one
 * earns its place there, so dropping any would be a regression for anyone already running
 * attention on a terminal. See src/attention/manifests/neutral.json's evidence for the table.
 */
describe("t-c59600 — neutral loses nothing the default set caught", () => {
  it("keeps every base rule", () => {
    const ids = attentionManifestForRuntime(undefined).rules.map((r) => r.id);
    for (const rule of BASE_MANIFEST.rules) expect(ids).toContain(rule.id);
  });

  it.each([
    // These are LLM-API-shaped rules that a terminal genuinely needs — the measured reason
    // neutral does not drop them.
    ["npm ERR! code E429\nnpm ERR! 429 Too Many Requests - GET https://registry.npmjs.org/foo", "error"],
    ["gh: API rate limit exceeded for user. Please try again later.", "error"],
    ["curl: (56) Recv failure: Connection reset by peer\nFetchError: request failed, ECONNRESET", "stall"],
    ["fatal: unable to access 'https://github.com/x/y.git/': Failed to connect, ETIMEDOUT", "stall"],
    // ...and the generic shell prompts base already handled.
    ["After this operation, 12.3 MB will be used.\nDo you want to continue? [Y/n]", "prompt"],
    ["[sudo] password for goat:", "prompt"],
    ["  build\n❯ 1. deploy\n  2. test", "prompt"],
  ])("still classifies %j as %s under neutral", (pane, kind) => {
    expect(classifyAttentionTail(pane)?.kind).toBe(kind);
  });
});

/**
 * What neutral ADDS: shell consent prompts the Claude-by-default set left uncovered. Each case is
 * asserted against BOTH manifests, so the test carries its own fail-before — it is red the moment
 * a runtime-less entry drifts back onto a runtime manifest.
 */
describe("t-c59600 — neutral covers shell prompts the default set missed", () => {
  it.each([
    ["npm/npx consent (the pane named in the task)", "Need to install the following packages:\n  cowsay@1.6.0\nOk to proceed? (y)"],
    // dpkg's answer line as it sits at the pane bottom once the options list has scrolled. The
    // prose above it ("What would you like to do about it ?") is what base matched, and it is not
    // guaranteed to still be in the tail window — the affordance line always is.
    ["dpkg conffile answer line", "*** foo.conf (Y/I/N/O/D/Z) [default=N] ?"],
    ["ssh key passphrase", "Enter passphrase for key '/home/goat/.ssh/id_ed25519':"],
    ["git credential username", "Username for 'https://github.com':"],
    ["terraform value", "Only 'yes' will be accepted to approve.\n\n  Enter a value:"],
    ["press any key", "Setup complete.\nPress any key to continue . . ."],
    ["cp overwrite", "cp: overwrite '/tmp/a.txt'?"],
    ["rm -i", "rm: remove regular file 'notes.txt'?"],
  ])("%s is a prompt under neutral and was NOT one under the old claude default", (_name, pane) => {
    expect(classifyAttentionTail(pane)?.kind).toBe("prompt");
    expect(evaluateAttentionManifest(attentionManifestForRuntime("claude"), pane)).toBeNull();
  });

  it.each([
    ["npm audit summary", "added 210 packages, and audited 211 packages in 4s\n0 vulnerabilities found in 12 package(s)"],
    ["coverage n/a", "Statements : 91.2% ( 812/890 )\nBranches   : (n/a)"],
    ["stack trace frame", "TypeError: x is not a function\n    at Object.<anonymous> (/app/src/x.js:12:5)"],
    ["make entering directory", "make[1]: Entering directory '/home/goat/build'\ngcc -c main.c"],
    ["ping output", "PING example.com (93.184.216.34) 56(84) bytes of data."],
    ["dev server", "$ npm run dev\n> vite dev\nserver running at :3000"],
    // Regression guard: the first draft of neutral_destructive_confirm matched this, turning a
    // prose question meant for a human (t-10771a's own fixture) into a shell keystroke prompt.
    ["prose question containing a destructive verb", "Can I delete the generated file?"],
  ])("does not latch on quiet terminal output: %s", (_name, pane) => {
    expect(classifyAttentionTail(pane)).toBeNull();
  });
});

/** The production door: a real terminal pane through AttentionMonitor with cmdOf → null. */
describe("t-c59600 — the terminal path itself", () => {
  it("marks a terminal needs-input on a neutral-only shell prompt", async () => {
    const pane = "npm warn config production Use `--omit=dev`\nNeed to install the following packages:\n  cowsay@1.6.0\nOk to proceed? (y)";
    // Fail-before, kept as a permanent counterfactual: the Claude manifest never saw this pane.
    expect(evaluateAttentionManifest(attentionManifestForRuntime("claude"), pane)).toBeNull();
    const seen = await terminalState(pane);
    expect(seen.state).toBe("needs-input");
    expect(seen.matchedLine).toBe("Ok to proceed? (y)");
  });

  it("leaves ordinary terminal output alone", async () => {
    const seen = await terminalState("$ npm run build\n> tsc -p .\nBuild succeeded in 4.1s");
    expect(seen.state).toBe("idle");
  });
});
