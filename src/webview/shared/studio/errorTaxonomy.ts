import type { StudioError, StudioValidationResult } from "@tachyon/engine/webview/shared/studio/errorTaxonomyTypes.js";
export type { StudioErrorSource, StudioError, StudioValidationResult } from "@tachyon/engine/webview/shared/studio/errorTaxonomyTypes.js";
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
