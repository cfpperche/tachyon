import type { GitDelivery } from "./types.js";
import type { GitDeliveryActor } from "./types.js";

export function canOpenGitDelivery(agent: string, actor: GitDeliveryActor, prunePrincipals: readonly string[]): boolean {
  if (actor.kind === "system" || actor.kind === "human" || actor.kind === "master") return true;
  if (actor.kind !== "agent" || !actor.name) return false;
  return actor.name === agent || prunePrincipals.includes(actor.name);
}

export function canPruneGitDelivery(delivery: GitDelivery, callerName: string | undefined, prunePrincipals: readonly string[]): boolean {
  return !!callerName && (callerName === delivery.agent || callerName === delivery.createdBy.name || prunePrincipals.includes(callerName));
}
