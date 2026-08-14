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
