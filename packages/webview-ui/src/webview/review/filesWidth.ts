/**
 * t-2f7e8c — review file-list width.
 *
 * Today's CSS default is 16rem (0.93.13). That number stays the default, not a new scale.
 * Persistence uses the same localStorage door Activity already uses for type filters —
 * not vscode.setState (that record is SectionPanelState) and not a new state file.
 */

export const REVIEW_FILES_WIDTH_DEFAULT_REM = 16;
/** Half of today's default — derived, so a min is not a new chosen length. */
export const REVIEW_FILES_WIDTH_MIN_REM = REVIEW_FILES_WIDTH_DEFAULT_REM / 2;
/** One rem — the host font-size, not a screen-chosen pixel step. */
export const REVIEW_FILES_WIDTH_STEP_REM = 1;
export const REVIEW_FILES_WIDTH_STORAGE_KEY = "tachyon.review.filesWidthRem";

export function parseStoredFilesWidthRem(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export function clampFilesWidthRem(rem: number, maxRem: number): number {
  const max = Math.max(REVIEW_FILES_WIDTH_MIN_REM, maxRem);
  return Math.min(max, Math.max(REVIEW_FILES_WIDTH_MIN_REM, rem));
}

export function readStoredFilesWidthRem(): number | undefined {
  if (typeof globalThis.localStorage === "undefined") return undefined;
  try {
    const parsed = parseStoredFilesWidthRem(globalThis.localStorage.getItem(REVIEW_FILES_WIDTH_STORAGE_KEY));
    if (parsed === undefined || parsed < REVIEW_FILES_WIDTH_MIN_REM) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeStoredFilesWidthRem(rem: number): void {
  if (typeof globalThis.localStorage === "undefined") return;
  try {
    globalThis.localStorage.setItem(REVIEW_FILES_WIDTH_STORAGE_KEY, String(rem));
  } catch {
    /* quota / private mode — width still applies in memory this session */
  }
}

export function filesWidthMaxRem(bodyWidthPx: number, rootFontPx: number): number {
  const root = rootFontPx > 0 ? rootFontPx : 16;
  return Math.max(REVIEW_FILES_WIDTH_MIN_REM, bodyWidthPx / root - REVIEW_FILES_WIDTH_MIN_REM);
}
