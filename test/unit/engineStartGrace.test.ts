/**
 * The engine's start budget is a FLOOR while the process is alive, not a ceiling.
 *
 * Measured on the author's machine: a cold start of the packaged engine straddles ten seconds on a
 * loaded box. Three installs in a row hit the budget dead-on (about a second of CPU consumed in ten of
 * wall clock — starved, not crashed), the rollback hit it too, and the human was shown "could not
 * start either the new engine or its verified rollback" and left clicking Retry.
 *
 * The first fix put the grace on ONE of the two wait loops. The install path runs the OTHER one, so
 * the next release failed the same way and the audit still read "did not answer within 10s" — the
 * grace existed and never ran. That is what these pin: both loops, by their own names, because a
 * guard that covers one of two symmetric paths teaches the wrong lesson about which one is safe.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("packages/engine/src/engine-service/engineSupervisor.ts", "utf8");

/** The body of one function, from its signature to the next top-level `async function`. */
function bodyOf(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} is not in the supervisor`).toBeGreaterThan(-1);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("a still-alive engine gets more room, on every road that waits for one", () => {
  for (const wait of ["waitForCompatibleEngine", "waitForExactEngine"]) {
    it(`${wait} extends its deadline while systemd still reports the unit active`, () => {
      const body = bodyOf(wait);
      expect(body, "the deadline must be reassignable, or the grace cannot apply").toContain("let deadline");
      expect(body).toContain("ALIVE_START_GRACE_MS");
      expect(body, "liveness is what separates slow from dead").toContain("unitStillActive(");
      // Once, not forever: a unit that never answers must still fail, and within a bounded time.
      expect(body).toContain("!extended");
    });
  }

  it("says how long it waited instead of announcing a catastrophe", () => {
    // "could not start either the new engine or its verified rollback" for a start that was merely
    // slow is what sent the human to Retry blind. The number is the fact that was missing.
    expect(source).toContain("did not answer within ${");
    expect(source).not.toContain("did not become ready in time");
  });
});
