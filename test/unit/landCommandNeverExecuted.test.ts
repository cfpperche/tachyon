import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "../../src");

/**
 * t-7cb971 — the product SUGGESTS a land command and never runs one.
 *
 * The record-only posture is a product decision under review, not a bug, and this slice deliberately
 * does not settle it: it delivers the half that is correct under either answer. What keeps that true
 * over time is this guard. `src/worktree/land.ts` builds a `git … merge --ff-only <sha>` STRING for a
 * human to paste, and the next person to touch it will be one refactor away from handing that string
 * to the `GitExec` the same module already holds — at which point the product would be mutating the
 * trunk with nobody having decided that it may.
 *
 * WHY IT SCANS ARGUMENT ARRAYS AND NOT LINES. A `grep` for `merge` matches `merge-base`, which this
 * module legitimately calls, and a grep for `--ff-only` matches the composed command it exists to
 * produce. Both would have to be excused, and an excused guard is the shape that failed here before:
 * on 2026-08-03 a static check compared line text against a `switch` body and every violation matched
 * as a substring of the switch's own `case`. So this parses the ARGUMENT LIST of each git-shaped call
 * and compares whole elements — the only reading under which `merge-base` and `merge` are different
 * words.
 *
 * PROVED RED BEFORE GREEN: adding `await git(["merge", "--ff-only", head], cwd)` to `land.ts` fails
 * this test naming that file, and adding `await git(["merge-base", "--is-ancestor", a, b], cwd)` does
 * not.
 */

/** Every `something([...])` argument list in a source file, as arrays of its string literals. */
function argumentArrays(source: string): string[][] {
  const arrays: string[][] = [];
  const re = /\(\s*\[([^\]]*)\]/g;
  for (const match of source.matchAll(re)) {
    const body = match[1];
    const literals = [...body.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    if (literals.length > 0) arrays.push(literals);
  }
  return arrays;
}

/**
 * The words that make a git invocation advance the TRUNK, which is the act this guard is about.
 *
 * `push` was in this set for one run and is deliberately not in it now. It caught
 * `src/worktree/pr.ts`, which pushes `refs/heads/<own branch>:refs/heads/<own branch>` behind the
 * human's publish gate (spec 223) — a worktree publishing its own branch, which is exactly what
 * docs/project-guidance permits and a different act from moving the trunk. Keeping `push` would have
 * meant carrying a named exception for a legitimate caller, and a guard whose first line is an excuse
 * is a guard the next reader learns to widen. The claim this test makes is the narrow one it can
 * actually defend.
 */
const MUTATING = new Set(["merge", "--ff-only"]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("the land command is composed, never executed", () => {
  it("no git invocation anywhere in src/ passes merge or --ff-only", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = fs.readFileSync(file, "utf8");
      for (const args of argumentArrays(source)) {
        const hit = args.find((arg) => MUTATING.has(arg));
        if (hit) offenders.push(`${path.relative(SRC, file)}: [${args.join(", ")}] contains '${hit}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads merge-base as a different word than merge, so the honest caller is not excused", () => {
    const args = argumentArrays(`await git(["merge-base", "--is-ancestor", a, b], cwd)`);
    expect(args).toEqual([["merge-base", "--is-ancestor"]]);
    expect(args.some((list) => list.some((arg) => MUTATING.has(arg)))).toBe(false);
    expect(argumentArrays(`await git(["merge", "--ff-only", head], cwd)`).some(
      (list) => list.some((arg) => MUTATING.has(arg)),
    )).toBe(true);
  });
});
