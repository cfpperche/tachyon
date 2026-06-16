import { describe, it, expect } from "vitest";
import {
  isGitHubRemote,
  prReadiness,
  composePrTitle,
  composePrBody,
  probePrReadiness,
  createWorktreePr,
  isWorktreeDirty,
  type CliExec,
  type CliResult,
} from "../../src/worktree/pr.js";

const ok = (stdout = ""): CliResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr = "", code = 1): CliResult => ({ stdout: "", stderr, code });

describe("isGitHubRemote", () => {
  it("matches ssh + https + ssh:// github, rejects others", () => {
    expect(isGitHubRemote("git@github.com:owner/repo.git")).toBe(true);
    expect(isGitHubRemote("https://github.com/owner/repo")).toBe(true);
    expect(isGitHubRemote("ssh://git@github.com/owner/repo")).toBe(true);
    expect(isGitHubRemote("git@gitlab.com:owner/repo.git")).toBe(false);
    expect(isGitHubRemote("https://bitbucket.org/x/y")).toBe(false);
    expect(isGitHubRemote("")).toBe(false);
  });
});

describe("prReadiness", () => {
  it("walks the blockers in order", () => {
    expect(prReadiness({ inWorktree: false, remoteUrl: "x", ghAvailable: true, ghAuthed: true }).reason).toMatch(/worktree/);
    expect(prReadiness({ inWorktree: true, remoteUrl: null, ghAvailable: true, ghAuthed: true }).reason).toMatch(/origin/);
    expect(prReadiness({ inWorktree: true, remoteUrl: "https://gitlab.com/x/y", ghAvailable: true, ghAuthed: true }).reason).toMatch(/GitHub/);
    expect(prReadiness({ inWorktree: true, remoteUrl: "git@github.com:o/r", ghAvailable: false, ghAuthed: false }).reason).toMatch(/gh/);
    expect(prReadiness({ inWorktree: true, remoteUrl: "git@github.com:o/r", ghAvailable: true, ghAuthed: false }).reason).toMatch(/authenticated/);
    expect(prReadiness({ inWorktree: true, remoteUrl: "git@github.com:o/r", ghAvailable: true, ghAuthed: true })).toEqual({ ready: true });
  });
});

describe("composePrTitle / composePrBody", () => {
  it("humanizes the branch leaf", () => {
    expect(composePrTitle("tachyon/fix-resume-bug")).toBe("Fix resume bug");
    expect(composePrTitle("feature/foo_bar")).toBe("Foo bar");
  });
  it("carries the verify verdict (✓/✗/⊘), omits the block when there's no verify", () => {
    expect(composePrBody({ branch: "b", base: "main", verify: { badge: "verified", command: "npm test" } })).toContain("✓ **Verify passed**: `npm test`");
    expect(composePrBody({ branch: "b", base: "main", verify: { badge: "failing", command: "npm test" } })).toContain("✗ **Verify FAILED**");
    expect(composePrBody({ branch: "b", base: "main", verify: { badge: "stale" } })).toContain("⊘ **Not verified**");
    const none = composePrBody({ branch: "b", base: "main" });
    expect(none).toContain("`b`");
    expect(none).not.toContain("Verify");
  });
  it("names the base branch when known, never a false forked-from provenance", () => {
    expect(composePrBody({ branch: "feat/x", base: "develop" })).toContain("`feat/x` → `develop`");
    expect(composePrBody({ branch: "feat/x" })).not.toContain("→"); // attached/unknown base → no claim
  });
});

describe("probePrReadiness", () => {
  it("github origin + gh present + authed → ready", async () => {
    const git: CliExec = async () => ok("git@github.com:o/r.git\n");
    const gh: CliExec = async (_c, args) => ok(args[0] === "--version" ? "gh 2.0" : "Logged in");
    expect(await probePrReadiness("/wt", true, git, gh)).toEqual({ ready: true });
  });
  it("gh present but not authed → reason", async () => {
    const git: CliExec = async () => ok("https://github.com/o/r\n");
    const gh: CliExec = async (_c, args) => (args[0] === "--version" ? ok("gh 2.0") : fail("not logged in"));
    expect((await probePrReadiness("/wt", true, git, gh)).reason).toMatch(/authenticated/);
  });
  it("gh binary absent (exec rejects) → not available", async () => {
    const git: CliExec = async () => ok("git@github.com:o/r\n");
    const gh: CliExec = async () => {
      throw new Error("gh binary not found");
    };
    expect((await probePrReadiness("/wt", true, git, gh)).reason).toMatch(/not found/);
  });
});

describe("isWorktreeDirty", () => {
  it("true on porcelain output, false when clean", async () => {
    expect(await isWorktreeDirty("/wt", async () => ok(" M src/x.ts\n"))).toBe(true);
    expect(await isWorktreeDirty("/wt", async () => ok(""))).toBe(false);
  });
});

describe("createWorktreePr", () => {
  const wt = { path: "/wt", branch: "feat/x", baseRef: "abc123" };
  it("pushes then creates; passes --base only when a base BRANCH is given (never a SHA)", async () => {
    const calls: string[][] = [];
    const git: CliExec = async (_c, args) => {
      calls.push(args);
      return ok();
    };
    const gh: CliExec = async (_c, args) => {
      calls.push(args);
      return ok("https://github.com/o/r/pull/7\n");
    };
    // no base → no --base flag; push uses a fully-qualified refspec (safe against a leading-'+' branch)
    await createWorktreePr(wt, { title: "T", body: "B" }, git, gh);
    expect(calls[1]).not.toContain("--base");
    expect(calls[0]).toEqual(["push", "-u", "origin", "refs/heads/feat/x:refs/heads/feat/x"]);
    // with a resolved base branch → --base <branch>
    calls.length = 0;
    const res = await createWorktreePr(wt, { title: "T", body: "B", base: "develop" }, git, gh);
    expect(res).toEqual({ url: "https://github.com/o/r/pull/7" });
    expect(calls[1]).toContain("--base");
    expect(calls[1]).toContain("develop");
  });
  it("surfaces the existing PR when one already exists (no error)", async () => {
    const git: CliExec = async () => ok();
    const gh: CliExec = async (_c, args) =>
      args[0] === "pr" && args[1] === "create"
        ? fail('a pull request for branch "feat/x" already exists')
        : ok("https://github.com/o/r/pull/3\n"); // pr view
    const res = await createWorktreePr(wt, { title: "T", body: "B" }, git, gh);
    expect(res).toEqual({ url: "https://github.com/o/r/pull/3", existing: true });
  });
  it("returns an error when push fails", async () => {
    const git: CliExec = async () => fail("permission denied");
    const gh: CliExec = async () => ok();
    const res = await createWorktreePr(wt, { title: "T", body: "B" }, git, gh);
    expect("error" in res && res.error).toMatch(/push failed/);
  });
});
