import { beforeEach } from "vitest";

/**
 * t-a12966 — a test whose value IS the real machine declares what it needs, and says so when it is
 * missing.
 *
 * Two shapes of the same defect motivated this. A test that only needs machine state to BUILD a
 * scenario (a credential file to link, a populated `.tachyon/`) must inject it instead — that test
 * asserts about its subject and has no business asking the host anything. What is left over is the
 * handful whose whole point is the real thing: the installed `codex` binary, a live tmux server, the
 * user's systemd session. Those cannot be doubled without deleting what they measure, so they
 * declare the dependency and skip.
 *
 * The skip has to be READABLE in the gate's output. `describe.skipIf(!binaryPresent())` reports a
 * pending test with no reason attached, which is how coverage disappears without anyone choosing it:
 * the gate prints "N skipped" and nobody can tell whether N is one deliberate live probe or a whole
 * suite that quietly stopped running. `context.skip(reason)` makes Vitest own the pending result, and
 * the meta key is what `scripts/verify-full.mjs` reads to print the reason beside the counters.
 *
 * `check` returns the reason it is unavailable, or `undefined` when the dependency is satisfied —
 * so the caller states the missing thing in the words the reader needs, at the moment the test runs.
 */
export function requireMachineDependency(check: () => string | undefined): void {
  beforeEach(async (context) => {
    const missing = check();
    if (!missing) return;
    (context.task.meta as Record<string, unknown>).machineDependencyUnavailable = missing;
    await context.annotate(missing, "skip");
    context.skip(missing);
  });
}
