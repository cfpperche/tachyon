import type { TachyonConfig } from "../config/loadConfig.js";
import type { GitDeliverySettings } from "./types.js";

/**
 * t-e88c8a — no principal can be configured any more, because `settings.gitDelivery` is gone.
 *
 * The two lists authorized integrate and prune on a linked GitDelivery, and every door into those
 * actions (`git_delivery_integrate`, `git_delivery_prune`, `delivery_salvage`) was retired with the
 * Delivery tool surface. Returning empty is therefore the ACCURATE answer, not a fallback: nobody
 * holds that authority, so the remaining internal callers refuse everyone except a delivery's own
 * creator — which is the check they applied before consulting this list at all.
 *
 * The function stays rather than being inlined so the refusal keeps a single, findable origin while
 * the rest of the subsystem is removed.
 */
export function resolveGitDeliverySettings(_settings: TachyonConfig["settings"] | undefined): GitDeliverySettings {
  return { prunePrincipals: [], integratePrincipals: [] };
}
