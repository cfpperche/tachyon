import { afterEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { createGitExec, type GitExec } from "../../src/worktree/WorktreeManager.js";

const ok = (stdout = ""): CliResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr = "", code = 1): CliResult => ({ stdout: "", stderr, code });

const tempDirs: string[] = [];

function fakeConfiguredGit(status: "dirty" | "fail" = "dirty"): { binary: string; cwd: string; trace: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pr-git-"));
  tempDirs.push(cwd);
  const binary = path.join(cwd, "git-configured");
  const trace = path.join(cwd, "git-trace.txt");
  const statusAction = status === "fail" ? ["printf '%s\\n' 'status failed' >&2", "exit 17"] : ["printf '%s\\n' ' M src/example.ts'", "exit 0"];
  fs.writeFileSync(
    binary,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$TACHYON_TEST_GIT_TRACE\"",
      "case \"$1\" in",
      "  remote)",
      "    if [ \"$2\" = \"get-url\" ] && [ \"$3\" = \"origin\" ]; then",
      "      printf '%s\\n' 'git@github.com:owner/repo.git'",
      "      exit 0",
      "    fi",
      "    ;;",
      "  status)",
      "    if [ \"$2\" = \"--porcelain\" ]; then",
      ...statusAction.map((line) => `      ${line}`),
      "    fi",
      "    ;;",
      "  push)",
      "    exit 0",
      "    ;;",
      "esac",
      "printf '%s\\n' \"unexpected git args: $*\" >&2",
      "exit 2",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { binary, cwd, trace };
}

async function withoutGitOnPath<T>(trace: string, run: () => Promise<T>): Promise<T> {
  const priorPath = process.env.PATH;
  const priorTrace = process.env.TACHYON_TEST_GIT_TRACE;
  process.env.PATH = "";
  process.env.TACHYON_TEST_GIT_TRACE = trace;
  try {
    return await run();
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorTrace === undefined) delete process.env.TACHYON_TEST_GIT_TRACE;
    else process.env.TACHYON_TEST_GIT_TRACE = priorTrace;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
  it("contains only branch context and the Tachyon footer", () => {
    expect(composePrBody({ branch: "b", base: "main" })).toBe("Branch `b` → `main`.\n\n🤖 Opened from a Tachyon worktree.");
  });
  it("names the base branch when known, never a false forked-from provenance", () => {
    expect(composePrBody({ branch: "feat/x", base: "develop" })).toContain("`feat/x` → `develop`");
    expect(composePrBody({ branch: "feat/x" })).not.toContain("→"); // attached/unknown base → no claim
  });
});

describe("probePrReadiness", () => {
  it("github origin + gh present + authed → ready", async () => {
    const git: GitExec = async () => ok("git@github.com:o/r.git\n");
    const gh: CliExec = async (_c, args) => ok(args[0] === "--version" ? "gh 2.0" : "Logged in");
    expect(await probePrReadiness("/wt", true, git, gh)).toEqual({ ready: true });
  });
  it("gh present but not authed → reason", async () => {
    const git: GitExec = async () => ok("https://github.com/o/r\n");
    const gh: CliExec = async (_c, args) => (args[0] === "--version" ? ok("gh 2.0") : fail("not logged in"));
    expect((await probePrReadiness("/wt", true, git, gh)).reason).toMatch(/authenticated/);
  });
  it("gh binary absent (exec rejects) → not available", async () => {
    const git: GitExec = async () => ok("git@github.com:o/r\n");
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
  it("treats a failed status probe as dirty instead of silently clean", async () => {
    expect(await isWorktreeDirty("/wt", async () => fail("status failed"))).toBe(true);
  });
});

describe("createWorktreePr", () => {
  const wt = { path: "/wt", branch: "feat/x", baseRef: "abc123" };
  it("pushes then creates; passes --base only when a base BRANCH is given (never a SHA)", async () => {
    const calls: string[][] = [];
    const git: GitExec = async (args) => {
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
    const git: GitExec = async () => ok();
    const gh: CliExec = async (_c, args) =>
      args[0] === "pr" && args[1] === "create"
        ? fail('a pull request for branch "feat/x" already exists')
        : ok("https://github.com/o/r/pull/3\n"); // pr view
    const res = await createWorktreePr(wt, { title: "T", body: "B" }, git, gh);
    expect(res).toEqual({ url: "https://github.com/o/r/pull/3", existing: true });
  });
  it("returns an error when push fails", async () => {
    const git: GitExec = async () => fail("permission denied");
    const gh: CliExec = async () => ok();
    const res = await createWorktreePr(wt, { title: "T", body: "B" }, git, gh);
    expect("error" in res && res.error).toMatch(/push failed/);
  });
});

describe("configured Git executor", () => {
  it("uses the configured executable for readiness, dirty checks, and pushes when PATH has no git", async () => {
    const fake = fakeConfiguredGit();
    const git = createGitExec(() => fake.binary);
    const gh: CliExec = async (_cmd, args) => ok(args[0] === "--version" ? "gh 2.0" : args[0] === "auth" ? "Logged in" : "https://github.com/owner/repo/pull/7\n");

    await withoutGitOnPath(fake.trace, async () => {
      expect(await probePrReadiness(fake.cwd, true, git, gh)).toEqual({ ready: true });
      expect(await isWorktreeDirty(fake.cwd, git)).toBe(true);
      expect(await createWorktreePr({ path: fake.cwd, branch: "feat/configured-git", baseRef: "abc123" }, { title: "Configured Git", body: "Body" }, git, gh)).toEqual({
        url: "https://github.com/owner/repo/pull/7",
      });
    });

    expect(fs.readFileSync(fake.trace, "utf8").trim().split("\n")).toEqual([
      "remote get-url origin",
      "status --porcelain",
      "push -u origin refs/heads/feat/configured-git:refs/heads/feat/configured-git",
    ]);
  });

  it("treats a configured executable's failed status as dirty when PATH has no git", async () => {
    const fake = fakeConfiguredGit("fail");
    const git = createGitExec(() => fake.binary);

    await withoutGitOnPath(fake.trace, async () => {
      expect(await isWorktreeDirty(fake.cwd, git)).toBe(true);
    });

    expect(fs.readFileSync(fake.trace, "utf8").trim()).toBe("status --porcelain");
  });
});
