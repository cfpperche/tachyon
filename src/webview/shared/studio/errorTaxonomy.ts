/**
 * spec 350 T1 — the studio shell's typed error taxonomy (dueto F10-F13). An adapter's validation result is
 * store-authoritative (it decides which of ITS OWN errors block save), but anything the adapter didn't
 * explicitly declare non-blocking — an unknown validation code, a persistence failure, a transport error —
 * is BLOCKING by default. That default lives here, not in each adapter, so an adapter can never accidentally
 * leave Save enabled while an error is showing (a bypass the shell's save-gating decision depends on).
 *
 * Display text is NOT this module's job: `message` here is a stable, localization-free fallback; the
 * webview layer maps `code` through the labels contract (labels.ts) when a localized string exists.
 */

export type StudioErrorSource = "validation" | "persistence" | "transport";

export interface StudioError {
  /** a stable identifier — protocol-level, never localized. */
  code: string;
  /** English fallback text (not user-facing once a `labels` mapping exists for `code`). */
  message: string;
  source: StudioErrorSource;
  blocking: boolean;
}

/** An adapter's validation pass returns its own errors split into blocking/non-blocking — the adapter is
 *  authoritative for VALIDATION codes it recognizes; the shell only defaults the codes it doesn't. */
export interface StudioValidationResult {
  blocking: StudioError[];
  nonBlocking: StudioError[];
}

export const NO_VALIDATION_ERRORS: StudioValidationResult = { blocking: [], nonBlocking: [] };

/** Wrap a raw persistence/transport failure as a blocking error — unknown-by-construction, since these two
 *  sources have no adapter-declared non-blocking case (spec: "unknown validation/persistence/transport
 *  errors are BLOCKING by default"). */
export function mapUnknownError(source: "persistence" | "transport", err: unknown, code = `${source}/unknown`): StudioError {
  return { code, message: err instanceof Error ? err.message : String(err), source, blocking: true };
}

/** Whether ANY error in a validation result blocks save — the single predicate the shell's save gate reads. */
export function hasBlockingErrors(result: StudioValidationResult): boolean {
  return result.blocking.length > 0;
}
