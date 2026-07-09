import { describe, expect, it } from "vitest";
import { resolveGitBinary, gitNotFoundError } from "../../src/worktree/gitBinary.js";

describe("container-generated delegation behavior", () => {
  it("git is resolved via setting or common-location probe when not on PATH, with a clear PATH-naming error", () => {
    // (a) a configured tachyon.gitPath setting wins over everything else.
    expect(resolveGitBinary({ configuredPath: "/opt/homebrew/bin/git", gitExtensionPath: "/other/git", pathExists: () => true })).toBe(
      "/opt/homebrew/bin/git",
    );

    // (b) with no tachyon.gitPath, the git extension's git.path setting resolves next (string or string[]).
    expect(resolveGitBinary({ gitExtensionPath: "/custom/git" })).toBe("/custom/git");
    expect(resolveGitBinary({ gitExtensionPath: ["/custom/git", "/other/git"] })).toBe("/custom/git");

    // (c) with neither configured, probe common locations via an injected (fake) fs — /usr/bin/git present.
    const onlyUsrBin = (p: string): boolean => p === "/usr/bin/git";
    expect(resolveGitBinary({ pathExists: onlyUsrBin })).toBe("/usr/bin/git");

    // (d) nothing configured and nothing probes → falls back to bare 'git' (PATH).
    expect(resolveGitBinary({ pathExists: () => false })).toBe("git");

    // when that final fallback also can't be spawned, the error NAMES the PATH problem and the remedy —
    // never a bare, cryptic "git binary not found".
    const err = gitNotFoundError();
    expect(err.message).not.toBe("git binary not found");
    expect(err.message).toMatch(/PATH/);
    expect(err.message).toMatch(/tachyon\.gitPath/);
    expect(err.message).toMatch(/git\.path/);
  });
});
