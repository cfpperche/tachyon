import fs from "node:fs";

/**
 * t-d62d90 — carry the one thing Vitest's JSON reporter throws away.
 *
 * Measured in vitest 3.2.6, and the whole reason this file exists:
 *
 * - `Vitest._checkUnhandledErrors(errors)` sets `process.exitCode = 1` when the run collected any
 *   unhandled error (a rejection or uncaught exception a worker forwarded outside a test body).
 * - `JsonReporter.onFinished(files, _errors = [], coverageMap)` takes that same error list as its
 *   second parameter and ignores it, and its `success` field is computed from failed suites and
 *   failed tests alone. So the report says `success: true`, 0 of 7932 failed.
 * - `logger.printUnhandledErrors` is reached only from `BaseReporter.printErrorsSummary`. The gate
 *   runs `--reporter=json` and nothing else, so no BaseReporter exists and nothing is printed.
 *
 * Those three facts compose into a gate that goes red, agrees it is green, and prints not one line
 * about why — which is the failure this reporter closes. It decides nothing: it writes the error
 * list to a file so `verify-full.mjs` can name the cause in its diagnostic.
 *
 * The dump happens on `process` exit rather than in `onFinished` on purpose. Vitest checks the error
 * list once, in the `finally` of `runFiles`, BEFORE reporters are told the run finished; an error a
 * worker forwards after that check sets no exit code and reaches no reporter argument. Reading the
 * state at exit is the latest moment available, so the errors that leave no other trace are exactly
 * the ones this catches.
 */
export const UNHANDLED_OUTPUT_ENV = "TACHYON_VITEST_UNHANDLED_FILE";

/** Vitest hands these across a worker boundary already serialized, so read defensively. */
function serialize(error) {
  if (!error || typeof error !== "object") return { message: String(error) };
  return {
    type: typeof error.type === "string" ? error.type : undefined,
    name: typeof error.name === "string" ? error.name : undefined,
    message: typeof error.message === "string" ? error.message : String(error.message ?? ""),
    stack: typeof error.stack === "string" ? error.stack : undefined,
    // Vitest tags a worker's error with the test file and whether it landed after environment
    // teardown — the difference between "a test leaks" and "a worker died on the way out".
    testPath: error.VITEST_TEST_PATH,
    testName: error.VITEST_TEST_NAME,
    afterEnvironmentTeardown: error.VITEST_AFTER_ENV_TEARDOWN,
  };
}

export default class UnhandledErrorReporter {
  onInit(vitest) {
    const file = process.env[UNHANDLED_OUTPUT_ENV];
    if (!file) return;
    process.on("exit", () => {
      let errors;
      try { errors = vitest.state.getUnhandledErrors(); } catch { return; }
      if (!Array.isArray(errors) || errors.length === 0) return;
      // Best-effort by design: a reporter that throws on the way out would turn a diagnostic into a
      // second failure, and the run's own verdict is already decided by this point.
      try { fs.writeFileSync(file, JSON.stringify(errors.map(serialize), null, 2), { mode: 0o600 }); } catch { /* ignore */ }
    });
  }
}
