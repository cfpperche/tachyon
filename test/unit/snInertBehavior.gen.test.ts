import { describe, expect, it } from "vitest";
import { shouldActivateFolder } from "../../apps/vscode-extension/src/workspace/workspaceFolderOps.js";

const WORKTREES_BASE = "/home/goat/.cache/tachyon/worktrees";

describe("container-generated delegation behavior", () => {
  it("a workspace folder under the Tachyon worktrees base stays inert and never boots a Bridge", () => {
    const revealedWorktreeFolder = `${WORKTREES_BASE}/ws1/snGuard`;
    expect(shouldActivateFolder(true, revealedWorktreeFolder, WORKTREES_BASE)).toBe(false);

    const normalProjectFolder = "/home/goat/projects/tachyon";
    expect(shouldActivateFolder(true, normalProjectFolder, WORKTREES_BASE)).toBe(true);
  });
});
