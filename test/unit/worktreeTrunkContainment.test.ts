/**
 * t-6ae9a8 — containment is measured against the CURRENT trunk, not the creation baseRef.
 *
 * The bug, measured on this host: eight change worktrees, all clean, all of whose commits were
 * already in `main`, each classified `needs-review` with "N commits not contained in base". The check
 * compared HEAD against the baseRef recorded at CREATION, which every landing makes older — so the
 * more successfully work landed, the more stubbornly its worktree looked unsafe to remove. Nothing
 * reclaimed them and they accumulated with a full `node_modules` apiece, on the box that has already
 * hit ENOSPC once.
 *
 * These use a REAL git repository rather than a stubbed exec, because the thing under test is an
 * ancestry question and a fake `git` would only assert my own beliefs about `merge-base` and
 * `cherry`. The four cases the fix has to separate:
 *
 *   1. stale baseRef + landed HEAD  → ready-to-remove   (the bug: was needs-review)
 *   2. dirty                        → needs-review      (must NOT loosen)
 *   3. genuinely uncontained branch → needs-review      (must NOT loosen)
 *   4. unresolvable trunk           → needs-review      (fail-closed)
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";
import { classifyManagedWorktree, resolveTrunkRefs } from "@tachyon/engine/worktree/classify.js";
import type { ManagedWorktreeEntry } from "@tachyon/engine/worktree/managedWorktree.js";
import type { GitExec, WorktreeStatus } from "@tachyon/engine/worktree/WorktreeManager.js";

/** A real repo: `main` with two commits, plus a branch whose single commit was merged into main. */
function repo(): { dir: string; birthRef: string; git: (...a: string[]) => string } {
  const dir = makeTempDir("wt-containment-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  // The ref the worktree would have recorded at creation.
  const birthRef = git("rev-parse", "HEAD");
  return { dir, birthRef, git };
}

const realGit: GitExec = async (args, cwd) => {
  try {
    return { code: 0, stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

function entry(dir: string, baseRef: string): ManagedWorktreeEntry {
  return {
    id: "mw-test", kind: "change", path: dir, branch: "feature", baseRef,
    tachyonCreatedBranch: true, slug: "test", createdAt: "2026-07-28T00:00:00.000Z",
    createdBy: "claude-opus5", status: "active",
  } as ManagedWorktreeEntry;
}

/** A clean status whose ahead-of-base count is measured against the (possibly stale) baseRef. */
function statusFor(dir: string, baseRef: string, over: Partial<WorktreeStatus> = {}) {
  return async (): Promise<WorktreeStatus> => {
    const ahead = Number(execFileSync("git", ["rev-list", "--count", `${baseRef}..HEAD`], { cwd: dir, encoding: "utf8" }).trim());
    return {
      staged: 0, unstaged: 0, untracked: 0, conflicts: 0, detached: false, branch: "feature",
      aheadOfBase: ahead, unpushed: 0, hasUpstream: false, ...over,
    };
  };
}

describe("t-6ae9a8 — a landed worktree is reclaimable even though its baseRef is stale", () => {
  it("classifies ready-to-remove when HEAD is in main but ahead of the recorded baseRef", async () => {
    const { dir, birthRef, git } = repo();
    // The worktree's work lands on main AFTER it was created — the ordinary case.
    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-q", "-m", "landed work");
    git("branch", "-f", "feature", "HEAD");

    // Ahead of its BIRTH ref, and yet fully contained in main. This is the exact shape of the eight.
    const ahead = Number(git("rev-list", "--count", `${birthRef}..HEAD`));
    expect(ahead).toBeGreaterThan(0);

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit, status: statusFor(dir, birthRef), trunkRef: "main",
    });
    expect(result.state, `reasons: ${result.reasons.join("; ")}`).toBe("ready-to-remove");
    expect(result.containedInTrunk).toBe(true);
    expect(result.reasons).toEqual([]);
    // The stale baseRef survives as information — it just no longer decides anything.
    expect(result.aheadOfBase).toBe(ahead);
    expect(result.trunkRef).toBe("main");
  });

  it("still reports ready-to-remove when the recorded baseRef no longer resolves at all", async () => {
    // A birth ref that was deleted says nothing about whether the work arrived. Previously an
    // unresolvable base was itself a blocker, which is a fact about history, not about safety.
    const { dir, git } = repo();
    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-q", "-m", "landed work");

    const result = await classifyManagedWorktree(entry(dir, "refs/heads/deleted-long-ago"), {
      git: realGit,
      status: async () => ({
        staged: 0, unstaged: 0, untracked: 0, conflicts: 0, detached: false, branch: "feature",
        aheadOfBase: 0, unpushed: 0, hasUpstream: false, aheadProbeFailed: true,
      }),
      trunkRef: "main",
    });
    expect(result.state, `reasons: ${result.reasons.join("; ")}`).toBe("ready-to-remove");
    expect(result.containedInTrunk).toBe(true);
  });
});

describe("t-6ae9a8 — the destructive checks are NOT loosened", () => {
  it("refuses a dirty worktree even when it is fully contained in main", async () => {
    // Containment answers "did the work arrive"; it cannot answer "is there uncommitted work here".
    const { dir, birthRef } = repo();
    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef, { unstaged: 1 }),
      trunkRef: "main",
    });
    expect(result.state).toBe("needs-review");
    expect(result.reasons.join("; ")).toMatch(/uncommitted changes/);
    expect(result.containedInTrunk).toBe(true); // contained, and STILL refused
  });

  it("refuses a branch whose commits are genuinely not in main", async () => {
    const { dir, birthRef, git } = repo();
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "unmerged.txt"), "never landed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "work that never landed");

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit, status: statusFor(dir, birthRef), trunkRef: "main",
    });
    expect(result.state).toBe("needs-review");
    expect(result.containedInTrunk).toBe(false);
    expect(result.reasons.join("; ")).toMatch(/not contained in base or in 'main'/);
  });

  it("refuses when NEITHER proof holds — unresolvable trunk AND commits not in base", async () => {
    // Corrected after this test taught me the rule: fail-closed applies to the absence of ANY proof,
    // not to the trunk specifically. My first version used a worktree with no unique commits and an
    // unresolvable trunk, and asserted needs-review — but that worktree is genuinely safe to remove,
    // because nothing unreachable from its base would be lost. The trunk only has to be resolvable
    // when it is the ONLY proof available. This is that case.
    const { dir, birthRef, git } = repo();
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "unmerged.txt"), "never landed anywhere\n");
    git("add", "-A");
    git("commit", "-q", "-m", "work in neither base nor trunk");

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit, status: statusFor(dir, birthRef), trunkRef: "refs/heads/no-such-trunk",
    });
    expect(result.state).toBe("needs-review");
    expect(result.containedInBase).toBe(false);
    expect(result.containedInTrunk).toBe(false);
  });

  it("accepts an unresolvable trunk when the BASE proof already holds", async () => {
    // The complement, stated so the rule is not accidentally tightened later: no unique commits vs its
    // base means removal loses nothing, whatever the trunk is called or whether it exists.
    const { dir, birthRef } = repo();
    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit, status: statusFor(dir, birthRef), trunkRef: "refs/heads/no-such-trunk",
    });
    expect(result.state).toBe("ready-to-remove");
    expect(result.containedInBase).toBe(true);
    expect(result.containedInTrunk).toBe(false);
  });

  it("refuses when the status probe itself failed, regardless of containment", async () => {
    const { dir, birthRef } = repo();
    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: async () => { throw new Error("git status exploded"); },
      trunkRef: "main",
    });
    expect(result.state).toBe("needs-review");
    expect(result.reasons.join("; ")).toMatch(/status probe failed/);
  });

  it("still reports occupied ahead of every other verdict", async () => {
    // A live agent in the directory outranks containment: the work being landed does not make it safe
    // to delete the floor someone is standing on.
    const { dir, birthRef } = repo();
    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef),
      occupancy: async () => ({ state: "live", agent: "ada", cwd: dir }),
      trunkRef: "main",
    });
    expect(result.state).toBe("occupied");
  });
});

describe("t-6ae9a8 — squash-merged work counts as contained", () => {
  it("accepts a branch whose patch is in main without shared ancestry", async () => {
    // `merge-base --is-ancestor` says no; the patch is nonetheless present. Rejecting this would keep
    // every squash-merged worktree unreclaimable forever, which is the same accumulation in a
    // different disguise.
    const { dir, birthRef, git } = repo();
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "c.txt"), "squashed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "feature work");
    const featureHead = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    // main must move FIRST, or cherry-pick fast-forwards (the picked commit is a direct child of
    // HEAD) and the histories never diverge — my first version of this test asserted a divergence it
    // had not actually created, and the precondition below caught it.
    fs.writeFileSync(path.join(dir, "trunk-only.txt"), "trunk moved\n");
    git("add", "-A");
    git("commit", "-q", "-m", "unrelated trunk commit");
    git("cherry-pick", featureHead);
    git("checkout", "-q", "feature");

    expect(() => execFileSync("git", ["merge-base", "--is-ancestor", featureHead, "main"], { cwd: dir })).toThrow();
    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit, status: statusFor(dir, birthRef), trunkRef: "main",
    });
    expect(result.containedInTrunk, `reasons: ${result.reasons.join("; ")}`).toBe(true);
    expect(result.state).toBe("ready-to-remove");
  });
});

/**
 * t-24e28d — the trunk is DISCOVERED, not assumed to be a branch literally named `main`.
 *
 * t-6ae9a8 fixed WHICH question containment asks ("is the work in the trunk", not "is it in the ref
 * this was born from"). It left the answer hardcoded to the string `main`, and every test above pins
 * `trunkRef` explicitly, so nothing exercised what production actually resolves. Two measured ways
 * that hardcode reproduces the ORIGINAL symptom — a clean, fully-landed worktree reported as
 * "N commit(s) not contained in base" — with the fail-closed default doing the damage:
 *
 *   · a repository whose trunk is called `master` (or anything else): `main` never resolves, so
 *     containment can never be proved and EVERY landed worktree is needs-review, forever;
 *   · a machine where `origin/main` has been fetched past a stale local `main`: work that landed
 *     upstream is in the trunk by any honest reading, and reads as uncontained.
 *
 * The safety half is asserted in the same breath: work that is in NO durable ref stays held.
 */

/** A repo whose trunk carries `trunkName`, optionally with a bare `origin` it has been pushed to. */
function repoWithTrunk(trunkName: string, opts: { withRemote?: boolean } = {}): {
  dir: string;
  birthRef: string;
  git: (...a: string[]) => string;
} {
  const dir = makeTempDir(`wt-trunkname-${trunkName}-`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", trunkName);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  const birthRef = git("rev-parse", "HEAD");
  if (opts.withRemote) {
    const remote = makeTempDir(`wt-trunkname-${trunkName}-origin-`);
    execFileSync("git", ["init", "-q", "--bare", "-b", trunkName, remote], { encoding: "utf8" });
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", trunkName);
    // What `git clone` writes and `git remote set-head` refreshes: the remote's DECLARED default.
    git("symbolic-ref", `refs/remotes/origin/HEAD`, `refs/remotes/origin/${trunkName}`);
  }
  return { dir, birthRef, git };
}

describe("t-24e28d — the trunk is resolved from the repository, not hardcoded to 'main'", () => {
  it("reclaims a landed worktree in a repo whose trunk is called 'master'", async () => {
    const { dir, birthRef, git } = repoWithTrunk("master");
    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-q", "-m", "landed work");
    git("branch", "-f", "feature", "HEAD");
    expect(Number(git("rev-list", "--count", `${birthRef}..HEAD`))).toBeGreaterThan(0);
    // Precondition: there is no `main` here at all, which is exactly what the hardcode assumed.
    expect(() => execFileSync("git", ["rev-parse", "--verify", "main^{commit}"], { cwd: dir })).toThrow();

    // No `trunkRef` injected — this is the production shape, and the whole point of the case.
    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef),
    });
    expect(result.state, `reasons: ${result.reasons.join("; ")}`).toBe("ready-to-remove");
    expect(result.containedInTrunk).toBe(true);
    expect(result.trunkRef).toBe("master");
  });

  it("still holds genuinely unlanded work in a 'master' repo", async () => {
    // The other half of the same discovery: finding the trunk must not become a way to say yes.
    const { dir, birthRef, git } = repoWithTrunk("master");
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "unmerged.txt"), "never landed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "work that never landed");

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef),
    });
    expect(result.state).toBe("needs-review");
    expect(result.containedInTrunk).toBe(false);
    expect(result.reasons.join("; ")).toMatch(/not contained in base or in 'master'/);
  });

  it("accepts work that landed on origin/main while the local main still lags", async () => {
    // A fetched-but-not-merged trunk is the developer-machine case: the work IS in the trunk, and
    // only a local branch pointer has not caught up. Refusing here is the same false alarm in a
    // different disguise.
    const { dir, birthRef, git } = repoWithTrunk("main", { withRemote: true });
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-q", "-m", "landed work");
    git("push", "-q", "origin", "feature:main"); // it lands upstream …
    git("fetch", "-q", "origin");
    // … and local `main` is left exactly where it was.
    expect(git("rev-parse", "main")).toBe(birthRef);
    expect(git("rev-parse", "origin/main")).toBe(git("rev-parse", "HEAD"));

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef),
    });
    expect(result.state, `reasons: ${result.reasons.join("; ")}`).toBe("ready-to-remove");
    expect(result.containedInTrunk).toBe(true);
    expect(result.trunkRef).toBe("origin/main");
  });

  it("holds work that is in NEITHER the local trunk nor its remote counterpart", async () => {
    const { dir, birthRef, git } = repoWithTrunk("main", { withRemote: true });
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "unmerged.txt"), "never landed anywhere\n");
    git("add", "-A");
    git("commit", "-q", "-m", "work in no durable ref");
    git("fetch", "-q", "origin");

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef),
    });
    expect(result.state).toBe("needs-review");
    expect(result.containedInBase).toBe(false);
    expect(result.containedInTrunk).toBe(false);
  });

  it("an explicitly injected trunkRef still wins over discovery", async () => {
    // Forks and tests pin the trunk; discovery is the DEFAULT, never an override.
    const { dir, birthRef, git } = repoWithTrunk("master");
    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-q", "-m", "landed work");

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef),
      trunkRef: "refs/heads/no-such-trunk",
    });
    expect(result.trunkRef).toBe("refs/heads/no-such-trunk");
    expect(result.containedInTrunk).toBe(false);
  });
});

describe("t-24e28d — resolveTrunkRefs", () => {
  it("prefers the remote's declared default branch and pairs it with its local branch", async () => {
    const { dir } = repoWithTrunk("release", { withRemote: true });
    expect(await resolveTrunkRefs(realGit, dir)).toEqual(["release", "origin/release"]);
  });

  it("falls back to the conventional local names when there is no remote", async () => {
    const { dir } = repoWithTrunk("master");
    expect(await resolveTrunkRefs(realGit, dir)).toEqual(["master"]);
  });

  it("names 'main' when nothing at all resolves, so a refusal can still say what it looked for", async () => {
    const dir = makeTempDir("wt-trunkname-empty-");
    execFileSync("git", ["init", "-q", "-b", "wip", dir], { encoding: "utf8" });
    expect(await resolveTrunkRefs(realGit, dir)).toEqual(["main"]);
  });
});

describe("t-24e28d — pre-resolved candidates, the seam ManagedWorktreeService sweeps through", () => {
  it("accepts a list resolved once for the whole repository", async () => {
    // listClassified resolves the trunk against the workspace root and hands the same list to every
    // row, so this is the shape production actually takes — worth a case of its own.
    const { dir, birthRef, git } = repoWithTrunk("master");
    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    git("add", "-A");
    git("commit", "-q", "-m", "landed work");

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef),
      trunkRefs: ["main", "master"],
    });
    expect(result.state, `reasons: ${result.reasons.join("; ")}`).toBe("ready-to-remove");
    expect(result.trunkRef).toBe("master"); // the candidate that carried the proof, not the first tried
  });

  it("still refuses unlanded work when none of the pre-resolved candidates contains it", async () => {
    const { dir, birthRef, git } = repoWithTrunk("master");
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(dir, "unmerged.txt"), "never landed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "work that never landed");

    const result = await classifyManagedWorktree(entry(dir, birthRef), {
      git: realGit,
      status: statusFor(dir, birthRef),
      trunkRefs: ["main", "master"],
    });
    expect(result.state).toBe("needs-review");
    expect(result.containedInTrunk).toBe(false);
    // Names the first candidate looked at, so the refusal points somewhere a reader can go.
    expect(result.trunkRef).toBe("main");
  });
});
