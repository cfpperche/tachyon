import { describe, expect, it } from "vitest";
import { AGENT_CATALOG, quickAddChips } from "@tachyon/engine/webview/formLogic.js";
import {
  canonicalAgentFields,
  newAgentRuntimeRefusal,
  serializeAgentPatch,
  type AgentStudioFields,
} from "../../packages/webview-ui/src/webview/agent-studio-shell/domain.js";
import { createProfileFromStudioMutation, patchProfileFromStudioMutation } from "@tachyon/shared/config/agentProfileStudio.js";
import { admitSavedAgentProposal, savedAgentCreateMutation } from "@tachyon/engine/agents/savedAgentProposal.js";
import { ATTESTED_RUNTIMES } from "@tachyon/shared/runtime/attestedRuntimes.js";

/**
 * t-d68b8b — creating a Saved Agent for a runtime Tachyon does not attest was a dead end, and this
 * suite measures the two halves of closing it: the form stops OFFERING the path, and every creation
 * door REFUSES it with a reason that survives the decision being reversed.
 *
 * The dead end, measured before the fix over the six runtimes that reached it (opencode, copilot,
 * agy, hermes, verboo, gemini): `serializeAgentPatch` dropped the canonical context and returned the
 * legacy `FormState`, `AgentStudioAdapter.save` saw a patch with no `kind: "agent-instance"` and
 * called `Workspace.studioSubmit`, and that refused `kind === "agent"` outright with "inline agent
 * editing is retired — create or edit the canonical agent in Agent Studio". The form sent the human
 * to the form they were already in. Five of the six were `alwaysVisible` Quick Add chips.
 *
 * Everything here is asserted against `ATTESTED_RUNTIMES` rather than a second copy of the list, so
 * attesting a runtime moves the form, the doors and this suite together. A test that named
 * "claude, codex, grok, pi" inline would go green on the day the product changed and the form did
 * not, which is the failure this task was reported as.
 */

const NON_ATTESTED = ["opencode", "copilot", "agy", "hermes", "verboo", "gemini"] as const;

function newFields(cmd: string): AgentStudioFields {
  return { ...canonicalAgentFields(), name: "helper", cmd };
}

describe("t-d68b8b — Quick Add offers only what the creation path accepts", () => {
  it("every chip names an attested runtime, whatever is detected on the machine", () => {
    const everything = AGENT_CATALOG.map((entry) => entry.bin);
    for (const chips of [quickAddChips([]), quickAddChips(everything)]) {
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) expect(ATTESTED_RUNTIMES).toContain(chip.bin);
    }
  });

  it("offers every attested runtime the catalog can name — the filter narrows, it does not drop", () => {
    // Detection is the OTHER gate: an attested runtime the catalog knows must appear once the
    // machine has it, or this filter would have quietly retired a runtime instead of a dead end.
    const detected = quickAddChips(AGENT_CATALOG.map((entry) => entry.bin)).map((chip) => chip.bin);
    for (const runtime of ATTESTED_RUNTIMES) {
      if (!AGENT_CATALOG.some((entry) => entry.bin === runtime)) continue;
      expect(detected).toContain(runtime);
    }
  });

  it("keeps the catalog wider than the chips, so attesting a runtime needs no re-authoring here", () => {
    // The label, install hint and logo for a blocked runtime stay written. This is the difference
    // between a reversible block and a deletion, and the owner's decision was explicitly "for now".
    for (const bin of NON_ATTESTED) {
      expect(AGENT_CATALOG.map((entry) => entry.bin)).toContain(bin);
      expect(quickAddChips([bin]).map((chip) => chip.bin)).not.toContain(bin);
    }
  });
});

describe("t-d68b8b — the form refuses before the human fills it in", () => {
  it.each(NON_ATTESTED)("refuses a new agent on %s, naming the creation path rather than the runtime", (runtime) => {
    const refusal = newAgentRuntimeRefusal(newFields(runtime));
    expect(refusal).toBeDefined();
    expect(refusal).toContain(runtime);
    expect(refusal).toContain(ATTESTED_RUNTIMES.join(", "));
    // The wording is the point of the task: the block is on the canonical creation path and is
    // reversible, NOT a verdict that the runtime is unfit. A refusal that read "unsupported runtime"
    // would record the wrong cause and outlive the decision.
    expect(refusal).toContain("creation path");
    expect(refusal).toContain("not a verdict on the runtime");
    expect(refusal).toMatch(/lifts as soon as the runtime is attested/);
  });

  it.each(ATTESTED_RUNTIMES)("says nothing about %s", (runtime) => {
    expect(newAgentRuntimeRefusal(newFields(runtime))).toBeUndefined();
    expect(newAgentRuntimeRefusal(newFields(`/usr/local/bin/${runtime}`))).toBeUndefined();
  });

  it("stays silent on a blank command — that is a missing field, not a runtime refusal", () => {
    expect(newAgentRuntimeRefusal(newFields(""))).toBeUndefined();
    expect(newAgentRuntimeRefusal(newFields("   "))).toBeUndefined();
  });

  it("stays silent on an agent that already exists, so a written profile is never trapped", () => {
    const existing = newFields("opencode");
    existing.canonical!.expectedRevision = "a".repeat(64);
    expect(newAgentRuntimeRefusal(existing)).toBeUndefined();
    // A legacy `agents:` entry is edited through the other writer entirely; this refusal is about
    // minting a canonical profile, so it must not speak for that form either.
    const { canonical: _canonical, ...legacy } = newFields("opencode");
    expect(newAgentRuntimeRefusal(legacy as AgentStudioFields)).toBeUndefined();
  });

  it.each(NON_ATTESTED)("never routes %s back to the retired legacy writer", (runtime) => {
    // Red before the fix: this returned a patch with no `kind`, which `AgentStudioAdapter.save`
    // handed to `Workspace.studioSubmit` — the call that answers "go to Agent Studio".
    const patch = serializeAgentPatch(newFields(runtime), true);
    expect(patch).toMatchObject({ kind: "agent-instance" });
  });
});

describe("t-d68b8b — every creation door refuses, not only the form", () => {
  const mutation = (adapter: string) => savedAgentCreateMutation("helper", { runtimeAdapter: adapter });

  it.each(NON_ATTESTED)("the Interface's canonical create refuses %s", (runtime) => {
    expect(() => createProfileFromStudioMutation(mutation(runtime))).toThrow(
      new RegExp(`runtime '${runtime}' cannot back a new canonical agent`),
    );
    expect(() => createProfileFromStudioMutation(mutation(runtime))).toThrow(/not a verdict on the runtime/);
  });

  it.each(ATTESTED_RUNTIMES)("the same door still creates %s", (runtime) => {
    expect(createProfileFromStudioMutation(mutation(runtime))).toMatchObject({
      runtime: { adapter: runtime, executable: runtime },
    });
  });

  it.each(NON_ATTESTED)("an Agent's propose_saved_agent for %s is refused at admission", (runtime) => {
    // The second actor through the same door: `runtime_adapter` is a free-form string on the Bridge
    // tool, so before this the proposal was admitted, shown to a human, approved — and the created
    // profile then failed to project. Refusing at admission is what keeps the human from ratifying
    // an agent that cannot run.
    const admission = admitSavedAgentProposal({
      proposer: "claude-runtime",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "helper", runtimeAdapter: runtime, rationale: "runs the nightly import" },
      base: { configSha256: "a".repeat(64) },
      pending: [],
      nowMs: Date.parse("2026-08-07T00:00:00.000Z"),
      id: "p-0001",
      roster: [],
    });
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.code).toBe("invalid_spec");
    expect(admission.reason).toContain("cannot back a new canonical agent");
  });

  it("still EDITS a profile whose runtime is not attested — refusing that would strand it", () => {
    // Only minting is blocked. A profile already on disk keeps its edit door open; the projection is
    // the layer that declines to run it, and taking the form away too would leave no way to change
    // the runtime to an attested one.
    const editable = savedAgentCreateMutation("helper", { runtimeAdapter: "opencode" }).editable;
    const current = {
      agentName: "helper",
      revision: "b".repeat(64),
      profile: { schemaVersion: 1 as const, agentId: "a".repeat(64), runtime: { adapter: "opencode", executable: "opencode" } },
      provenance: { authority: { capabilityReferenceIds: [] } },
    };
    const patched = patchProfileFromStudioMutation(
      { schemaVersion: 1, kind: "agent-instance", agentName: "helper", expectedRevision: "b".repeat(64), editable },
      current as unknown as Parameters<typeof patchProfileFromStudioMutation>[1],
    );
    expect(patched.runtime).toMatchObject({ adapter: "opencode" });
  });
});
