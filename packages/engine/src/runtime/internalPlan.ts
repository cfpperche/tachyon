/**
 * Canonical internal-plan item. Other runtime readers import this file and map onto it.
 *
 * Status vocabulary is closed: a fourth value needs an explicit contract change.
 * `id` and `blockedBy` are optional because not every runtime has them — omit, never invent.
 */
export const INTERNAL_PLAN_STATUSES = ["pending", "in-progress", "completed"] as const;
export type InternalPlanStatus = (typeof INTERNAL_PLAN_STATUSES)[number];

export interface InternalPlanItem {
  readonly id?: string;
  readonly texto: string;
  readonly status: InternalPlanStatus;
  readonly blockedBy?: readonly string[];
}

/**
 * Empty snapshot (the channel spoke with zero items) is not mute (the channel never spoke).
 * Both are readable; they are not the same state.
 */
export type InternalPlanRead =
  | { readonly state: "mute" }
  | { readonly state: "snapshot"; readonly items: readonly InternalPlanItem[] };

export function isInternalPlanStatus(value: string): value is InternalPlanStatus {
  return (INTERNAL_PLAN_STATUSES as readonly string[]).includes(value);
}
