import { execFileSync } from "node:child_process";

/**
 * Run a vitest file in a CHILD vitest, and fail with the child's own output.
 *
 * t-690f52 — the two `.gen` tests that do this used to assert `expect(() => execFileSync(...))
 * .not.toThrow()`, which reported exactly one thing: "Error: Command failed: npx vitest run…". That
 * is the single part of a nested failure that carries no information — the cause is always in the
 * child's stderr, and the assertion threw it away. The red ran 1 gate in 6 for weeks and never once
 * said why; the first thing anyone diagnosing it had to do was reproduce it by hand to see the
 * message the test already had in its hands.
 *
 * It mattered here specifically: the cause was the child being refused by the host-wide vitest
 * budget while loading `vitest.config.ts`, and that refusal names the pool, the holders and the
 * shortfall. Propagating it turns a mystery flake into a report.
 */
export function runNestedVitest(testFile: string): void {
  try {
    execFileSync("npx", ["vitest", "run", testFile], { cwd: process.cwd(), stdio: "pipe" });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const section = (name: string, buffer?: Buffer): string => {
      const text = buffer?.toString().trim();
      return `--- child ${name} ---\n${text && text.length > 0 ? text : "(empty)"}`;
    };
    throw new Error(
      `nested \`npx vitest run ${testFile}\` failed: ${failure.message ?? String(error)}\n`
      + `${section("stderr", failure.stderr)}\n${section("stdout", failure.stdout)}`,
    );
  }
}
