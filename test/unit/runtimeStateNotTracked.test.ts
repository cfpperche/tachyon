/**
 * t-0675c8 — `.tachyon/` is runtime state, and runtime state is not repository content.
 *
 * The rule is the owner's (2026-08-21) and it had already been decided once, in the wrong direction:
 * `3ab02057` unversioned `.tachyon/` exactly as `.gitignore` had always said, and `5788983d` forced
 * three study files back into the index because two tests read them. That reasoning was right about
 * the WHAT — a file under test is repository content — and wrong about the WHERE. `.tachyon/` is a
 * directory the runtime creates, mutates and can lose without that being loss of code: on 2026-08-21
 * an `rm -rf` took the workspace and the only thing that made those three files survivors was that
 * git happened to be holding them against its own ignore rule.
 *
 * A convention that has already been reversed once will be reversed again. This is the same rule as
 * an executable invariant: the index is asked directly, so it cannot be satisfied by intent.
 *
 * NOT a style check. The exception below is the one legitimate case — a FIXTURE workspace has to
 * carry a `.tachyon/` because the thing under test is what Tachyon reads out of one.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();

/** Fixture workspaces are declared workspaces on purpose: their `.tachyon/` IS the input. */
const FIXTURE_PREFIX = "test/fixtures/";

function trackedUnderTachyon(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((file) => file.startsWith(".tachyon/") || file.includes("/.tachyon/"))
    .filter((file) => !file.startsWith(FIXTURE_PREFIX))
    .sort();
}

describe("runtime state is never repository content", () => {
  it("no path under a workspace `.tachyon/` is tracked, outside fixture workspaces", () => {
    // The failure message has to name the way OUT, not just the rule: the three files this guard was
    // written for were tracked for a real reason, and the fix was to move them, never to delete them.
    expect(trackedUnderTachyon(), [
      "`.tachyon/` is runtime state: a file tracked there is one an `rm -rf` of the workspace would",
      "make git the accidental custodian of. If a test needs it, it is a fixture — move it under",
      "test/fixtures/ (studies live in test/fixtures/studies/) and repoint the test, the way t-0675c8",
      "did. Only a fixture workspace's own `.tachyon/` may be tracked.",
    ].join("\n")).toEqual([]);
  });

  it("the ignore rule covers the real directory, so nothing lands there by accident", () => {
    // `git check-ignore` answers for UNTRACKED paths, so while the studies were force-added it exited
    // 1 here and looked like a broken rule (t-0675c8 recorded that suspicion). It was not the rule: it
    // was the tracking. With the index clean the rule answers plainly, and this pins that it does.
    const ignored = execFileSync("git", ["check-ignore", ".tachyon/anything.md"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(ignored.trim()).toBe(".tachyon/anything.md");
  });
});
