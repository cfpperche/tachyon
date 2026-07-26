import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/probe/adapters/claude.js";
import { codexAdapter } from "../../src/probe/adapters/codex.js";
import { grokAdapter } from "../../src/probe/adapters/grok.js";
import type { HeadlessCaptureAdapter, ProbeSpec } from "../../src/probe/adapters/types.js";

/**
 * SDD 474 / t-be9405 — the provenance obligations every probe adapter owes, asserted across the
 * whole fleet rather than one runtime at a time:
 *   1. the requested model reaches the native invocation
 *   2. it either proves its effective model or is an explicitly reasoned exemption
 *   3. an adapter that proves one names what KIND of evidence it is (SDD 476)
 * Obligation 4 (extract only structured evidence, never infer) is per-adapter and lives in each
 * adapter's own test; the exemption map below is what stops a new adapter drifting in unproven.
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
 *
 * SDD 476 emptied it. Codex was the last entry: `exec --json` still emits no model identity, but the
 * probe now correlates its own session rollout by `thread_id` and reads `turn_context.payload.model`
 * out of it, so the exemption no longer describes reality.
 */
const PROVENANCE_EXEMPT: Record<string, string> = {};

/** buildInvocation may touch disk (SDD 476), so give it a real scratch dir rather than a fake path. */
const scratchDirs: string[] = [];
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-parity-scratch-"));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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
  it.each(FLEET)("%s passes the requested model to its native invocation", async (_name, adapter) => {
    const args = (await adapter.buildInvocation(spec("some-model-id"), scratch())).args;
    const at = args.indexOf("--model");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe("some-model-id");
  });

  it.each(FLEET)("%s omits --model entirely when none was requested", async (_name, adapter) => {
    expect((await adapter.buildInvocation(spec(), scratch())).args).not.toContain("--model");
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

  it.each(FLEET)("%s that proves a model also declares what kind of evidence it is (SDD 476)", (_name, adapter) => {
    if (adapter.reportsEffectiveModel !== true) return;
    expect(["provider-usage", "session-record"]).toContain(adapter.modelEvidence);
  });

  it("the exemption list never grows silently — it names exactly the runtimes that cannot prove", () => {
    const exempt = FLEET.filter(([, a]) => a.reportsEffectiveModel !== true).map(([n]) => n).sort();
    expect(exempt).toEqual(Object.keys(PROVENANCE_EXEMPT).sort());
    // Claude (SDD 473), Grok (SDD 474) and Codex (SDD 476) all prove theirs now.
    expect(exempt).toEqual([]);
  });

  it("the fleet's evidence kinds are what each runtime can actually support", () => {
    // Provider usage accounting where the provider reports it; a runtime session record where only
    // the CLI's own log names the model. Collapsing these would over-state the Codex verdict.
    expect(claudeAdapter.modelEvidence).toBe("provider-usage");
    expect(grokAdapter.modelEvidence).toBe("provider-usage");
    expect(codexAdapter.modelEvidence).toBe("session-record");
  });
});
