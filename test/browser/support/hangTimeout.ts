/**
 * Hang-detection timeout for browser `waitFor*` calls — NOT a performance budget.
 *
 * Why this exists (t-efb7cc): `uiGate` (and siblings) used per-selector bounds of 1–2s with
 * no written reason and no commit that chose them by measurement. Under CPU contention those
 * bounds failed first (measured failure at ~3071 ms against a 2000 ms wait), so red meant
 * "machine busy" rather than "code broken." Vitest already backstops each test at
 * `testTimeout: 30_000` in `vitest.browser.config.ts`.
 *
 * This constant is a hang guard only: a genuine stall still fails in acceptable time (below
 * the vitest backstop), without asserting UI speed. Anyone who wants to assert speed must
 * write an explicit speed assertion with its own measured budget and rationale.
 */
export const HANG_TIMEOUT_MS = 25_000;
