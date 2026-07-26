import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/probe/adapters/claude.js";
import { codexAdapter } from "../../src/probe/adapters/codex.js";
import { grokAdapter } from "../../src/probe/adapters/grok.js";
import type { HeadlessCaptureAdapter, ProbeSpec } from "../../src/probe/adapters/types.js";

/**
 * SDD 474 / t-be9405 — the provenance obligations every probe adapter owes, asserted across the
 * whole fleet rather than one runtime at a time:
 *   1. the requested model reaches the native invocation
 *   2. it either proves its effective model or is an explicitly reasoned exemption
 * Obligations 3 and 4 (extract only structured evidence, never infer) are per-adapter and live in
 * each adapter's own test; the exemption map below is what stops a new adapter drifting in unproven.
 */

/** Every adapter registered for the probe lane (`Workspace.ts` — keep in step). */
const FLEET: Array<[string, HeadlessCaptureAdapter]> = [
  ["claude", claudeAdapter],
  ["codex", codexAdapter],
  ["grok", grokAdapter],
];

/**
 * A runtime may be exempt from proving its effective model ONLY with a recorded reason. This is a
 * decision log, not a mute allowlist: adding an entry is a deliberate, reviewable act.
 */
const PROVENANCE_EXEMPT: Record<string, string> = {
  codex: "measured on codex-cli 0.145.0: `exec --json` emits thread/turn/usage records with no model"
    + " identity, and the rollout carrying turn_context.payload.model is suppressed by --ephemeral"
    + " (t-a10d31)",
};

function spec(model?: string): ProbeSpec {
  return {
    runtime: "x",
    prompt: "hello",
    cwd: "/w",
    timeoutMs: 1000,
    ...(model ? { model } : {}),
  } as ProbeSpec;
}

describe("SDD 474 — probe provenance parity across the adapter fleet", () => {
  it.each(FLEET)("%s passes the requested model to its native invocation", (_name, adapter) => {
    const args = adapter.buildInvocation(spec("some-model-id"), "/scratch").args;
    const at = args.indexOf("--model");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe("some-model-id");
  });

  it.each(FLEET)("%s omits --model entirely when none was requested", (_name, adapter) => {
    expect(adapter.buildInvocation(spec(), "/scratch").args).not.toContain("--model");
  });

  it.each(FLEET)("%s either proves its effective model or is an explicitly reasoned exemption", (name, adapter) => {
    if (adapter.reportsEffectiveModel === true) {
      // A runtime that claims it can prove its model must not also be listed as exempt.
      expect(PROVENANCE_EXEMPT[name]).toBeUndefined();
      return;
    }
    const reason = PROVENANCE_EXEMPT[name];
    expect(reason, `adapter '${name}' reports no effective model and has no recorded exemption`).toBeTruthy();
    expect(reason.length).toBeGreaterThan(20);
  });

  it("the exemption list never grows silently — it names exactly the runtimes that cannot prove", () => {
    const exempt = FLEET.filter(([, a]) => a.reportsEffectiveModel !== true).map(([n]) => n).sort();
    expect(exempt).toEqual(Object.keys(PROVENANCE_EXEMPT).sort());
    // Today only Codex; Claude (SDD 473) and Grok (SDD 474) both prove theirs.
    expect(exempt).toEqual(["codex"]);
  });
});
