/**
 * t-610705 (SDD 410 Phase D, D0, round-3 blocker #3) — a SYNCHRONOUS pub-sub for the navigation-
 * transaction freeze messages (studioNavCheckpoint/studioNavAbort/studioSaveBegin/studioSaveEnd).
 *
 * Round 1/2's design promised the client freezes "synchronously on checkpoint receipt — before any
 * further edit can land." Round 1/2's FIRST implementation routed these messages through
 * cockpit/main.tsx's normal `setState` + `useEffect` pipeline, same as every other host push — but
 * React/Preact effects run AFTER a render commits, not synchronously with the message event that
 * triggered the state update, and an `onInput` keystroke event queued in between can still reach the
 * DOM and mutate `fields` before the freeze effect ever runs (round-3 blocker: "the freeze hook is
 * effect-driven and cannot prove freeze-moment atomicity").
 *
 * This module is the fix: cockpit/main.tsx's message listener calls `dispatchStudioFreezeMessage`
 * DIRECTLY (a plain synchronous function call, not a state update) the instant one of these four
 * message types arrives. The studio App's `useStudioFreeze` hook registers ONE listener (Control
 * hosts at most one active studio binding, same singleton assumption as activityBinding) whose
 * FIRST action, still inside this synchronous call stack, is to flip an imperative ref
 * (`frozenRef.current = true`) that field `onInput` handlers check directly — no render, no effect,
 * no scheduling in the critical path. `setFrozen(true)` (React state, for the CSS dimming) still
 * happens, but it's cosmetic now, not the enforcement mechanism.
 */
export type StudioFreezeBusMessage =
  | { type: "studioNavCheckpoint"; txnId: string }
  | { type: "studioNavAbort"; txnId: string }
  | { type: "studioSaveBegin" }
  | { type: "studioSaveEnd" };

type Listener = (msg: StudioFreezeBusMessage) => void;

let listener: Listener | undefined;

/** Registers the ONE active studio App's synchronous handler; pass `undefined` to unregister
 *  (unmount). A second registration REPLACES the first — Control hosts at most one active studio
 *  binding at a time, so there is never a legitimate reason for two listeners simultaneously. */
export function setStudioFreezeListener(fn: Listener | undefined): void {
  listener = fn;
}

/** Called from cockpit/main.tsx's message listener — synchronous, no React involved. Returns false
 *  (no-op) if nothing is currently mounted to receive it (e.g. a late message after unmount). */
export function dispatchStudioFreezeMessage(msg: StudioFreezeBusMessage): boolean {
  if (!listener) return false;
  listener(msg);
  return true;
}

/** True if the message's `type` belongs to this bus — cockpit/main.tsx uses this to decide whether
 *  to route a raw host message here instead of through the normal `studioIncoming` state pipeline
 *  (the two are mutually exclusive per message: a freeze message never ALSO carries
 *  `studioProtocolVersion`, so there's no double-handling risk either way, but keeping them on
 *  separate pipelines makes the synchronous-delivery guarantee auditable at the dispatch site). */
export function isStudioFreezeBusMessage(raw: { type?: unknown }): raw is StudioFreezeBusMessage {
  return raw.type === "studioNavCheckpoint" || raw.type === "studioNavAbort" || raw.type === "studioSaveBegin" || raw.type === "studioSaveEnd";
}
