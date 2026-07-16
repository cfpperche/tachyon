import type { CallerSnapshot } from "../bridge/callerIdentity.js";
import type { GitDeliveryActor } from "./types.js";

type LinkedMutationCaller = Pick<CallerSnapshot, "kind" | "name"> | { kind: "system"; name?: string };

/**
 * Linked projection mutation authority (SDD 368 T15).
 * Ephemeral execution name, GitDelivery.agent, createdBy, and attribution principal never grant
 * integrate/prune by equality. Requires privileged human/system/master or an agent explicitly
 * listed in the relevant principal allowlist.
 */
export function canMutateLinkedGitDelivery(
  _actor: GitDeliveryActor,
  principals: readonly string[],
  caller?: LinkedMutationCaller,
): boolean {
  // `actor` is attribution only. Linked mutations are accepted only after Bridge
  // has resolved a caller identity; legacy compatibility never conveys this power.
  if (!caller) return false;
  const kind = caller.kind;
  if (kind === "system" || kind === "human" || kind === "master") return true;
  const name = caller.kind === "agent" ? caller.name : undefined;
  return !!name && principals.includes(name);
}

export function canIntegrateLinkedGitDelivery(
  actor: GitDeliveryActor,
  integratePrincipals: readonly string[],
  caller?: LinkedMutationCaller,
): boolean {
  return canMutateLinkedGitDelivery(actor, integratePrincipals, caller);
}

export function canPruneLinkedGitDelivery(
  actor: GitDeliveryActor,
  prunePrincipals: readonly string[],
  caller?: LinkedMutationCaller,
): boolean {
  return canMutateLinkedGitDelivery(actor, prunePrincipals, caller);
}
