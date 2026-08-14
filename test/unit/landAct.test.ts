import { describe, expect, it } from "vitest";
import { landAct } from "@tachyon/engine/worktree/landAct.js";
import type { GitExec } from "@tachyon/engine/worktree/WorktreeManager.js";

/**
 * SDD 498 (t-7cb971) — the act reports what it OBSERVED, never what it intended.
 *
 * Every case here is one of the spec's acceptance scenarios, and the two that matter most are the ones
 * where git returned zero: a merge that succeeded is not the same fact as a trunk that arrived where we
 * asked. The adversarial review measured exactly that on git 2.53.0 — a `switch other` inside the
 * probe-to-act window made `git merge --ff-only <sha>` advance `other` and leave `main` untouched.
 */

const BEFORE = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const OTHER = "3333333333333333333333333333333333333333";

/**
 * A git that answers `rev-parse` from a script of successive values and records what it was asked. The
 * trunk is read twice — before and after — so its answers are a QUEUE: that is the whole mechanism
 * under test, and a fake that returned one fixed value could not express "the act moved something
 * else".
 */
function fakeGit(script: {
  trunk: Array<string | null>;
  merge?: { code: number; stderr?: string; stdout?: string };
  headBranch?: string | null;
  origHead?: string | null;
}): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const trunk = [...script.trunk];
  const git: GitExec = async (args) => {
    calls.push(args);
    const fail = { stdout: "", stderr: "", code: 128 };
    if (args[0] === "rev-parse") {
      if (args[1] === "--abbrev-ref") {
        return script.headBranch ? { stdout: `${script.headBranch}\n`, stderr: "", code: 0 } : fail;
      }
      if (args[1] === "ORIG_HEAD") {
        return script.origHead ? { stdout: `${script.origHead}\n`, stderr: "", code: 0 } : fail;
      }
      const next = trunk.shift();
      return next ? { stdout: `${next}\n`, stderr: "", code: 0 } : fail;
    }
    if (args[0] === "merge") {
      const m = script.merge ?? { code: 0 };
      return { stdout: m.stdout ?? "", stderr: m.stderr ?? "", code: m.code };
    }
    return fail;
  };
  return { git, calls };
}

const deps = (git: GitExec) => ({ git, primaryPath: "/repo", trunkRef: "main", head: HEAD });

describe("landAct", () => {
  it("fast-forwards the trunk and reports where it moved from and to", async () => {
    const { git, calls } = fakeGit({ trunk: [BEFORE, HEAD] });
    const result = await landAct(deps(git));

    expect(result).toEqual({
      ok: true,
      trunkRef: "main",
      primaryPath: "/repo",
      head: HEAD,
      before: BEFORE,
      after: HEAD,
    });
    // The act names the SHA, never the branch: the command and the evidence must describe one tree.
    expect(calls).toContainEqual(["merge", "--ff-only", HEAD]);
  });

  it("reports git's own refusal verbatim, and claims only that THIS invocation moved nothing", async () => {
    const { git } = fakeGit({
      trunk: [BEFORE, BEFORE],
      merge: { code: 128, stderr: "fatal: Not possible to fast-forward, aborting.\n" },
    });
    const result = await landAct(deps(git));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("git-refused");
    expect(result.reason).toBe("fatal: Not possible to fast-forward, aborting.");
    // The honest claim is about this attempt — NOT "the trunk is unchanged", which losing a
    // compare-and-swap race would make false.
    expect(result.fix).toContain("was not moved by this attempt");
    expect(result.fix).not.toContain("the trunk is unchanged");
  });

  it("calls a merge that advanced ANOTHER branch a failure, and names the branch and the undo", async () => {
    // The measured window: git moved whatever HEAD pointed at. The trunk read comes back unchanged.
    const { git } = fakeGit({ trunk: [BEFORE, BEFORE], headBranch: "other", origHead: OTHER });
    const result = await landAct(deps(git));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("moved-elsewhere");
    expect(result.reason).toContain("'other'");
    expect(result.reason).toContain("HEAD pointed at");
    // Actionable, and from git's own record rather than any state Tachyon kept.
    expect(result.fix).toContain(`git -C /repo reset --hard ${OTHER.slice(0, 12)}`);
    expect(result.fix).toContain("land again");
  });

  it("still refuses when the trunk ended somewhere unexpected and ORIG_HEAD cannot be read", async () => {
    const { git } = fakeGit({ trunk: [BEFORE, OTHER], headBranch: "main", origHead: null });
    const result = await landAct(deps(git));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("moved-elsewhere");
    expect(result.fix).toContain("reflog");
  });

  it("refuses before touching anything when the trunk head cannot be read", async () => {
    const { git, calls } = fakeGit({ trunk: [null] });
    const result = await landAct(deps(git));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unmeasured");
    expect(result.fix).toContain("git can run");
    // Nothing ran: an unmeasured precondition is never a licence to act.
    expect(calls.some((args) => args[0] === "merge")).toBe(false);
  });

  it("does not claim success when the trunk cannot be read back", async () => {
    const { git } = fakeGit({ trunk: [BEFORE, null] });
    const result = await landAct(deps(git));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unmeasured");
    expect(result.reason).toContain("could not be read back");
  });

  it("every refusal carries a non-empty exit, not only a diagnosis", async () => {
    const cases = [
      fakeGit({ trunk: [null] }),
      fakeGit({ trunk: [BEFORE, BEFORE], merge: { code: 1, stderr: "boom" } }),
      fakeGit({ trunk: [BEFORE, BEFORE], headBranch: "other", origHead: OTHER }),
      fakeGit({ trunk: [BEFORE, null] }),
    ];
    for (const { git } of cases) {
      const result = await landAct(deps(git));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.fix.length).toBeGreaterThan(0);
    }
  });
});
