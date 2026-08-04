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

/**
 * The bound for a wait whose expected outcome is that the selector NEVER appears — the `it.fails`
 * probes for components T4/T6 deliberately do not ship (Tooltip, Dialog).
 *
 * `HANG_TIMEOUT_MS` answers "I expect this to appear; fail if it never does". These probes ask the
 * opposite question — "I expect this NOT to appear" — and a generous bound is pure waste there,
 * because the absence is KNOWN rather than suspected. Six probes at the hang budget turned a ~40s
 * suite into ~180s, and 156s of that was spent proving something already documented in the file's
 * own header. The browser suite rides the conditional gate, so every `src/webview/**` change paid it.
 *
 * Kept deliberately short: if Radix ever ships the fix these probes watch for, the content mounts
 * fast and the probe flips to passing — which is the signal the `.fails` modifier exists to give.
 */
export const EXPECTED_ABSENCE_TIMEOUT_MS = 2_000;
