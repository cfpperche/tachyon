/**
 * Waiting helpers for unit tests that drive REAL processes and files — and the distinction the
 * browser suite already writes down in `test/browser/support/hangTimeout.ts`, missing on this side.
 *
 * Three questions look alike and are not:
 *
 *  1. **"I expect this to become true."** → `waitUntil`. A generous bound, because it only costs time
 *     when the test is already failing. `sleep(N); expect(x).toBe(y)` is this question written as an
 *     assertion about SPEED: it passes only if the effect lands within N, which nobody chose by
 *     measurement and the machine's load decides.
 *
 *  2. **"I expect this to have STOPPED."** → `waitStable`. Reading once after a fixed sleep cannot
 *     tell "it stopped" from "it has not started yet", which is exactly how `tmux.real`'s unpipe check
 *     failed under load: two bytes were still in flight when the single read happened (`expected 96 to
 *     be 94`). Stability is observed across reads, never assumed from one.
 *
 *  3. **"I expect this NEVER to happen."** → a short bound, as `EXPECTED_ABSENCE_TIMEOUT_MS` argues:
 *     a generous wait on a known absence is pure waste. Not implemented here because this side has no
 *     case for it yet; add it with its own reason when one appears rather than reusing (1) or (2).
 *
 * The vitest per-test timeout is the real backstop, so these bounds are hang guards, not budgets.
 * Anyone who wants to assert a speed must write that assertion explicitly, with a measured number and
 * a reason — which is a legitimate thing to do and a different thing from these.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface WaitOptions {
  /** hang guard, not a budget. Generous on purpose: it only costs time on a test that fails anyway. */
  timeoutMs?: number;
  /** gap between observations. */
  intervalMs?: number;
  /** what to say when the bound is reached — the caller's own words beat a generic timeout. */
  label?: string;
}

/**
 * Poll `read` until `holds` accepts its value, then return it.
 *
 * On timeout it throws with the LAST OBSERVED value included. That matters more than it looks: a
 * fixed-sleep assertion that fails tells you the final state and nothing about the trajectory, and
 * "expected 96 to be 94" reads like a wrong number when the truth was "still arriving".
 */
export async function waitUntil<T>(
  read: () => T | Promise<T>,
  holds: (value: T) => boolean,
  { timeoutMs = 10_000, intervalMs = 25, label = "condition" }: WaitOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!holds(last)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label}: never held within ${timeoutMs}ms; last observed ${JSON.stringify(last)}`);
    }
    await sleep(intervalMs);
    last = await read();
  }
  return last;
}

export interface StableOptions extends WaitOptions {
  /**
   * How many consecutive equal observations count as stopped. Two is enough for a value that only
   * grows (a file being appended to); raise it for something that can pause mid-flight.
   */
  reads?: number;
}

/**
 * Wait until `read` returns the same value `reads` times in a row, and return it.
 *
 * This is the honest shape for "the writer detached / the stream ended": it observes the stopping
 * rather than assuming it from a clock. A test that then asserts on the settled value is asserting
 * an OUTCOME; the same test with a fixed sleep was asserting that the outcome arrives within N.
 */
export async function waitStable<T>(
  read: () => T | Promise<T>,
  { timeoutMs = 10_000, intervalMs = 50, reads = 3, label = "value" }: StableOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  let repeats = 1;
  while (repeats < reads) {
    if (Date.now() >= deadline) {
      throw new Error(`${label}: never settled within ${timeoutMs}ms; last observed ${JSON.stringify(last)}`);
    }
    await sleep(intervalMs);
    const next = await read();
    repeats = Object.is(next, last) ? repeats + 1 : 1;
    last = next;
  }
  return last;
}
