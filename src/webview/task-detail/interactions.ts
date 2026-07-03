/**
 * spec 335 — pure decision helpers for the Task Detail panel's per-field stale marking (dogfood round 1, #2),
 * extracted so the concurrency edge is unit-testable without a DOM (same rationale as
 * mission-control/interactions.ts). The Preact component only dispatches events; every actual DECISION
 * (which field a CAS failure stales, when a stale marker clears) funnels through this one reducer.
 */

import { isStaleError } from "../mission-control/interactions";

export type DetailField = "priority" | "assignee";

export interface DetailStaleState {
  pendingField: DetailField | null;
  priorityStale: boolean;
  assigneeStale: boolean;
}

export const INITIAL_STALE_STATE: DetailStaleState = { pendingField: null, priorityStale: false, assigneeStale: false };

export type StaleEvent =
  | { type: "clearField"; field: DetailField } // begin-edit or an explicit refresh click — no submit in flight
  | { type: "submit"; field: DetailField } // a patch was just dispatched for this field
  | { type: "error"; message: string } // the host rejected the in-flight patch (or some other error arrived)
  | { type: "vmPush" }; // a fresh task snapshot arrived — the screen is current, any stale marker is moot

/**
 * The original bug: a single CAS failure flagged BOTH priority and assignee regardless of which write raced,
 * the flags never cleared on a live refresh, and the "refresh" link only dismissed the flag locally. This
 * reducer fixes all three: `error` stales only `state.pendingField` (never the other field), and `vmPush`
 * unconditionally clears both — a fresh push means the screen already reflects the current task, so an old
 * stale marker no longer applies.
 */
export function reduceDetailStale(state: DetailStaleState, event: StaleEvent): DetailStaleState {
  switch (event.type) {
    case "clearField":
      return event.field === "priority" ? { ...state, priorityStale: false } : { ...state, assigneeStale: false };
    case "submit":
      return {
        ...state,
        pendingField: event.field,
        ...(event.field === "priority" ? { priorityStale: false } : { assigneeStale: false }),
      };
    case "error": {
      const field = state.pendingField;
      if (!field || !isStaleError(event.message)) return { ...state, pendingField: null };
      return { ...state, pendingField: null, ...(field === "priority" ? { priorityStale: true } : { assigneeStale: true }) };
    }
    case "vmPush":
      return { ...state, priorityStale: false, assigneeStale: false };
  }
}
