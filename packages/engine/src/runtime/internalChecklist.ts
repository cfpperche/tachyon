/**
 * Canonical checklist item. Other runtime readers import this file and map onto it.
 *
 * Status vocabulary is closed: a fourth value needs an explicit contract change.
 * `id` and `blockedBy` are optional because not every runtime has them — omit, never invent.
 */
export const INTERNAL_CHECKLIST_STATUSES = ["pending", "in-progress", "completed"] as const;
export type InternalChecklistStatus = (typeof INTERNAL_CHECKLIST_STATUSES)[number];

export interface InternalChecklistItem {
  readonly id?: string;
  readonly text: string;
  readonly status: InternalChecklistStatus;
  readonly blockedBy?: readonly string[];
}

/**
 * Empty snapshot (the channel spoke with zero items) is not mute (the channel never spoke).
 * Both are readable; they are not the same state.
 */
export type InternalChecklistRead =
  | { readonly state: "mute" }
  | { readonly state: "snapshot"; readonly items: readonly InternalChecklistItem[] };

export function isInternalChecklistStatus(value: string): value is InternalChecklistStatus {
  return (INTERNAL_CHECKLIST_STATUSES as readonly string[]).includes(value);
}
