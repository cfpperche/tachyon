import { createHash } from "node:crypto";
import type { AgentProfileReferenceV1, AgentProfileV1 } from "./agentProfileSchema.js";
import { EVOLUTION_SELECTOR_PATH } from "./agentProfileProjection.js";

/**
 * t-f96b2f — the ONE rule for binding (and unbinding) an agent's Evolution selector, shared by every
 * door that can reach the effect.
 *
 * `Workspace.enableAgentSelfEvolution` (t-d185e1) built this shape first and was the only writer;
 * Agent Studio's toggle is the second door, and it cannot simply call that method — a Studio save is
 * ONE transaction against ONE expected revision, so the selector has to ride the same patch as the
 * rest of the form rather than land in a second commit the first one would then conflict with. Two
 * doors, one rule, stated here instead of twice.
 *
 * ## Turning it OFF is not the mirror image of turning it on, and that asymmetry is the whole module
 *
 * Enabling writes three things (bytes, a pinned reference, `prompt.evolution`). Disabling has to
 * remove TWO of them: dropping `prompt.evolution` while leaving the reference behind does not
 * "merely leave residue" — `projectCanonicalAgentProfile` refuses the entire profile for a
 * non-capability reference nothing points at ("referenced setup/prompt materialization is not
 * available yet"), so the agent would stop loading altogether. The inverse is refused one layer
 * earlier still: `agentProfileSchemaV1`'s `requireKind` fails a `prompt.evolution` with no matching
 * entry. Neither half can be written without the other.
 *
 * The selector FILE is deliberately left on disk when the binding goes away, the same orphan
 * `agentWorkspaceCommandWrite` accepts: nothing reads an unreferenced file (`resolveReferences`
 * iterates `profile.references`, never the directory), and teaching the lifecycle transaction to
 * delete artifacts would add a compensation path with real failure modes to reclaim ~90 bytes.
 * Re-enabling republishes it — the Evolution store returns the SAME profile id, so the bytes and the
 * digest come back identical, and the store's learnings and skills were never touched by the toggle
 * in the first place. Turning Evolution off pauses the capability; it does not discard what the
 * agent learned.
 */

/** The reference id this writer pins the selector under. */
export const EVOLUTION_SELECTOR_REFERENCE_ID = "evolution";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The selector bytes. Exactly two keys, because `readEvolutionSelector` refuses any extra one — the
 * file is a pinned document whose digest the profile carries, so its content is a contract.
 */
export function evolutionSelectorText(profileId: string): string {
  return `${JSON.stringify({ profileId, schemaVersion: 1 })}\n`;
}

/** A profile-local reference entry without the two fields the transaction fills from the agent id. */
export type LocalEvolutionSelectorReference = Omit<AgentProfileReferenceV1, "scope" | "owner">;

export interface EvolutionSelectorWrite {
  /** Published in the same transaction as the patch; empty unless a new selector is being pinned. */
  artifacts: Array<{ path: string; text: string; sha256: string }>;
  /** The entry to add — at most one, and only when the binding is being created. */
  localReferences: LocalEvolutionSelectorReference[];
  /** What `prompt.evolution` must be after the save. `undefined` CLEARS the binding. */
  promptEvolution: string | undefined;
}

/**
 * True when granting Evolution requires the store to mint a profile id first.
 *
 * The order is forced by who mints the id: the store does, never the author, and
 * `AgentManager.evolutionForFreshSession` refuses a spawn whose snapshot id disagrees with the
 * pinned one. So a caller asks this BEFORE minting, and mints only when the answer is yes — an agent
 * that already carries a selector keeps the id it has, and one that is being switched off must not
 * get an Evolution profile created as a side effect of turning the capability down.
 */
export function evolutionSelectorNeedsProfileId(
  profile: Pick<AgentProfileV1, "prompt">,
  enabled: boolean,
): boolean {
  return enabled && profile.prompt?.evolution === undefined;
}

/**
 * What this save should publish for the Evolution toggle.
 *
 * Already-on stays on with its OWN id: re-pinning would rewrite bytes nobody asked to change, and an
 * agent whose selector was hand-authored under a different id would silently have it replaced. The
 * save that does not touch the toggle is therefore a no-op by construction, which is the property
 * the round trip depends on.
 */
export function evolutionSelectorWriteFor(
  profile: Pick<AgentProfileV1, "prompt">,
  enabled: boolean,
  mintedProfileId?: string,
): EvolutionSelectorWrite {
  const pinned = profile.prompt?.evolution;
  if (!enabled) return { artifacts: [], localReferences: [], promptEvolution: undefined };
  if (pinned !== undefined) return { artifacts: [], localReferences: [], promptEvolution: pinned };
  if (!mintedProfileId) {
    throw new Error("enabling Evolution requires the profile id minted by the Evolution store");
  }
  const text = evolutionSelectorText(mintedProfileId);
  const sha256 = digest(text);
  return {
    artifacts: [{ path: EVOLUTION_SELECTOR_PATH, text, sha256 }],
    localReferences: [{
      id: EVOLUTION_SELECTOR_REFERENCE_ID,
      kind: "evolution",
      path: EVOLUTION_SELECTOR_PATH,
      mode: "pinned",
      sha256,
    }],
    promptEvolution: EVOLUTION_SELECTOR_REFERENCE_ID,
  };
}

/**
 * The `references[]` the save should write, given whatever the rest of the save already decided.
 *
 * `base` exists because Agent Studio composes writers: the workspace-command writer rebuilds the
 * list first, and this one edits THAT list rather than the stored one. Chaining on the stored list
 * twice would drop the other writer's work.
 *
 * A save that changes nothing about the binding returns `base` untouched — including the existing
 * selector entry, which is what keeps an unrelated edit from unbinding Evolution.
 */
export function mergedEvolutionSelectorReferences(
  profile: Pick<AgentProfileV1, "prompt" | "references" | "agentId">,
  write: EvolutionSelectorWrite,
  base: readonly AgentProfileReferenceV1[] = profile.references ?? [],
): AgentProfileReferenceV1[] {
  const pinned = profile.prompt?.evolution;
  if (write.promptEvolution === pinned && write.localReferences.length === 0) return [...base];
  // Both ids: the one the profile actually points at (which a hand-authored profile may have named
  // anything) and this writer's own, so re-enabling cannot leave a stale entry beside the new one.
  const dropped = new Set([pinned, EVOLUTION_SELECTOR_REFERENCE_ID].filter((id): id is string => id !== undefined));
  return [
    ...base.filter((reference) => !dropped.has(reference.id)),
    ...write.localReferences.map((reference) => ({
      ...reference,
      scope: "profile" as const,
      owner: profile.agentId,
    })),
  ];
}

/**
 * The patch's `prompt` with the binding applied — `undefined` when nothing is left in it, because the
 * lifecycle merge treats an explicit `undefined` as removal and an empty `{}` would persist as a key
 * that says nothing.
 */
export function promptWithEvolutionSelector(
  prompt: AgentProfileV1["prompt"] | undefined,
  write: EvolutionSelectorWrite,
): AgentProfileV1["prompt"] | undefined {
  const next = { ...(prompt ?? {}) };
  if (write.promptEvolution === undefined) delete next.evolution;
  else next.evolution = write.promptEvolution;
  return Object.keys(next).length > 0 ? next : undefined;
}
