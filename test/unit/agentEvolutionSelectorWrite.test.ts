import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVOLUTION_SELECTOR_REFERENCE_ID,
  evolutionSelectorNeedsProfileId,
  evolutionSelectorText,
  evolutionSelectorWriteFor,
  mergedEvolutionSelectorReferences,
  promptWithEvolutionSelector,
} from "../../src/config/agentEvolutionSelectorWrite.js";
import { EVOLUTION_SELECTOR_PATH } from "../../src/config/agentProfileProjection.js";
import type { AgentProfileReferenceV1, AgentProfileV1 } from "../../src/config/agentProfileSchema.js";

/**
 * t-f96b2f — the contract under Agent Studio's Evolution toggle.
 *
 * `Workspace.enableAgentSelfEvolution` (t-d185e1) wrote the selector, the pin and the field in one
 * transaction and had ZERO callers; the form rendered the toggle `disabled={canonical}` with
 * `canonical` always true. Wiring the control gave the rule a SECOND door, so the rule moved out of
 * that method and into a module both doors read — a bare enable and an idempotent form save cannot
 * be allowed to disagree about what a selector binding is.
 *
 * The end-to-end round trip (turn on, reopen, save untouched, still on — then off, same) is in
 * `workspaceHeadless.test.ts` against the real Workspace. This suite owns the shape underneath it,
 * and especially the asymmetry: enabling adds three things, disabling has to remove two of them.
 */

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const digest = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");

const foreignReference: AgentProfileReferenceV1 = {
  id: "workspace-verify",
  kind: "verification",
  scope: "profile",
  owner: AGENT_ID,
  path: "workspace-verify",
  mode: "pinned",
  sha256: digest("npm test\n"),
} as AgentProfileReferenceV1;

function profile(over: Partial<AgentProfileV1> = {}): AgentProfileV1 {
  return {
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    ...over,
  } as AgentProfileV1;
}

/** A profile that already carries the binding, as the writer itself would have left it. */
function bound(id = EVOLUTION_SELECTOR_REFERENCE_ID): AgentProfileV1 {
  const text = evolutionSelectorText(PROFILE_ID);
  return profile({
    prompt: { evolution: id },
    references: [foreignReference, {
      id,
      kind: "evolution",
      scope: "profile",
      owner: AGENT_ID,
      path: EVOLUTION_SELECTOR_PATH,
      mode: "pinned",
      sha256: digest(text),
    } as AgentProfileReferenceV1],
  });
}

describe("t-f96b2f — the Evolution selector write", () => {
  it("mints only when the binding is being created", () => {
    expect(evolutionSelectorNeedsProfileId(profile(), true)).toBe(true);
    // Already bound: the id it has is the id it keeps. Re-minting would republish bytes nobody asked
    // to change, and `AgentManager.evolutionForFreshSession` refuses a spawn on a disagreeing id.
    expect(evolutionSelectorNeedsProfileId(bound(), true)).toBe(false);
    // And turning the capability OFF must not create an Evolution profile on its way out.
    expect(evolutionSelectorNeedsProfileId(profile(), false)).toBe(false);
    expect(evolutionSelectorNeedsProfileId(bound(), false)).toBe(false);
  });

  it("writes bytes, a pinned reference and the field together, naming the id the store minted", () => {
    const write = evolutionSelectorWriteFor(profile(), true, PROFILE_ID);
    const text = `${JSON.stringify({ profileId: PROFILE_ID, schemaVersion: 1 })}\n`;
    // Exactly two keys and a trailing newline: `readEvolutionSelector` refuses any extra one, so the
    // bytes are a contract rather than a formatting preference.
    expect(write.artifacts).toEqual([{ path: EVOLUTION_SELECTOR_PATH, text, sha256: digest(text) }]);
    expect(write.localReferences).toEqual([{
      id: EVOLUTION_SELECTOR_REFERENCE_ID,
      kind: "evolution",
      path: EVOLUTION_SELECTOR_PATH,
      mode: "pinned",
      sha256: digest(text),
    }]);
    expect(write.promptEvolution).toBe(EVOLUTION_SELECTOR_REFERENCE_ID);
  });

  it("refuses to bind without the id only the store can mint", () => {
    expect(() => evolutionSelectorWriteFor(profile(), true, undefined))
      .toThrow(/requires the profile id minted by the Evolution store/);
  });

  it("is a no-op for a save that leaves an enabled toggle enabled", () => {
    const write = evolutionSelectorWriteFor(bound(), true, undefined);
    expect(write).toEqual({ artifacts: [], localReferences: [], promptEvolution: EVOLUTION_SELECTOR_REFERENCE_ID });
    // This is the property the round trip rests on: an unrelated edit publishes nothing at all.
    expect(mergedEvolutionSelectorReferences(bound(), write)).toEqual(bound().references);
  });

  it("keeps a hand-authored selector id instead of replacing it with its own", () => {
    const write = evolutionSelectorWriteFor(bound("custom-evolution"), true, undefined);
    expect(write.promptEvolution).toBe("custom-evolution");
    expect(mergedEvolutionSelectorReferences(bound("custom-evolution"), write))
      .toEqual(bound("custom-evolution").references);
  });

  it("takes the reference WITH the field when the toggle goes off", () => {
    const current = bound();
    const write = evolutionSelectorWriteFor(current, false);
    expect(write).toEqual({ artifacts: [], localReferences: [], promptEvolution: undefined });
    // Not tidiness: `projectCanonicalAgentProfile` refuses the WHOLE profile over a non-capability
    // reference nothing points at, so leaving the entry behind would stop the agent from loading.
    expect(mergedEvolutionSelectorReferences(current, write)).toEqual([foreignReference]);
    expect(promptWithEvolutionSelector(current.prompt, write)).toBeUndefined();
  });

  it("removes a hand-authored id too, rather than only the one it writes", () => {
    const current = bound("custom-evolution");
    const write = evolutionSelectorWriteFor(current, false);
    expect(mergedEvolutionSelectorReferences(current, write)).toEqual([foreignReference]);
  });

  it("edits the list the previous writer produced, not the stored one", () => {
    // Agent Studio composes writers: the workspace-command merge runs first and hands its output in
    // as `base`. Chaining on the stored list twice would silently drop that writer's work — measured
    // as a digest mismatch in the headless round trip.
    const rebuilt: AgentProfileReferenceV1 = { ...foreignReference, sha256: digest("npm run typecheck\n") };
    const write = evolutionSelectorWriteFor(profile(), true, PROFILE_ID);
    const merged = mergedEvolutionSelectorReferences(profile(), write, [rebuilt]);
    expect(merged[0]).toEqual(rebuilt);
    expect(merged[1]).toMatchObject({ id: EVOLUTION_SELECTOR_REFERENCE_ID, scope: "profile", owner: AGENT_ID });
  });

  it("leaves the rest of the prompt alone in both directions", () => {
    const on = evolutionSelectorWriteFor(profile(), true, PROFILE_ID);
    expect(promptWithEvolutionSelector({ role: "reviewer", soul: "soul" }, on))
      .toEqual({ role: "reviewer", soul: "soul", evolution: EVOLUTION_SELECTOR_REFERENCE_ID });
    const off = evolutionSelectorWriteFor(bound(), false);
    expect(promptWithEvolutionSelector({ role: "reviewer", evolution: EVOLUTION_SELECTOR_REFERENCE_ID }, off))
      .toEqual({ role: "reviewer" });
    // Emptied rather than left as `{}`: the lifecycle merge reads an explicit `undefined` as removal,
    // and an empty mapping would persist as a key that says nothing.
    expect(promptWithEvolutionSelector(undefined, off)).toBeUndefined();
  });
});
