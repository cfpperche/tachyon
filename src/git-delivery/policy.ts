import type { GitDelivery } from "./types.js";

export function canPruneGitDelivery(delivery: GitDelivery, callerName: string | undefined, prunePrincipals: readonly string[]): boolean {
  return !!callerName && (callerName === delivery.agent || callerName === delivery.createdBy.name || prunePrincipals.includes(callerName));
}
