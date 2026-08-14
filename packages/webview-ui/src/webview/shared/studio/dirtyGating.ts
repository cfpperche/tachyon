/**
 * spec 350 T1 — the shell's SAVE gate: pure, DOM-free, no adapter bypass. Save is enabled iff there is
 * something to save, nothing blocking is showing, no save is already in flight, and concurrency isn't
 * stale — a taxonomy-driven AND, not a per-adapter decision (dueto F9/F10: "an adapter can never surface an
 * error while leaving save enabled").
 */

export interface SaveGateInput {
  dirty: boolean;
  blockingErrorCount: number;
  saveInFlight: boolean;
  concurrencyStale: boolean;
}

export function canSave(input: SaveGateInput): boolean {
  return input.dirty && input.blockingErrorCount === 0 && !input.saveInFlight && !input.concurrencyStale;
}

export interface DirtyBannerInput {
  dirty: boolean;
  canDiscard: boolean;
}

/** Whether the shell must confirm before discarding (Cancel/reload-latest/etc.) — dirty AND the adapter says
 *  the current fields aren't already equivalent to the last loaded/saved snapshot. */
export function requiresDiscardConfirmation(input: DirtyBannerInput): boolean {
  return input.dirty && !input.canDiscard;
}
