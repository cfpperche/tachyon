import { describe, expect, it } from "vitest";
import { computeWorkspaceFolderOps } from "../../apps/vscode-extension/src/workspace/workspaceFolderOps.js";

const BASE = "/home/goat/.cache/tachyon/worktrees/ws1";

describe("container-generated delegation behavior", () => {
  it("computeWorkspaceFolderOps adds live worktrees, removes cleaned ones, self-heals orphans, and never touches user folders", () => {
    const userFolders = [
      { path: "/home/goat/tachyon", name: "tachyon" },
      { path: "/home/goat/tachyon-plugins", name: "tachyon-plugins" },
      { path: "/home/goat/tachyon-ade-bench", name: "tachyon-ade-bench" },
    ];

    // A worktree still tracked and already reflected as a folder → no-op (idempotent).
    const alreadyPresent = { path: `${BASE}/alpha`, name: "alpha" };
    // A folder under the base with no matching live worktree → removed (explicit cleanup).
    const cleanedUp = { path: `${BASE}/bravo`, name: "bravo" };
    // A folder under the base with no matching live worktree, surviving from before a reload
    // (the worktree it pointed at is long gone) → removed (self-heal of orphans).
    const orphan = { path: `${BASE}/charlie`, name: "charlie" };

    const currentFolders = [...userFolders, alreadyPresent, cleanedUp, orphan];
    const liveWorktrees = [
      { path: alreadyPresent.path, agent: "alpha" },
      { path: `${BASE}/delta`, agent: "delta" }, // brand-new worktree not yet a folder → add
    ];

    const ops = computeWorkspaceFolderOps(currentFolders, liveWorktrees, BASE);

    expect(ops.add).toEqual([{ path: `${BASE}/delta`, name: "delta" }]);

    const removedPaths = ops.remove.map((i) => currentFolders[i].path);
    expect(removedPaths.sort()).toEqual([cleanedUp.path, orphan.path].sort());

    // User folders are NEVER in remove, even when liveWorktrees is empty.
    const emptyLiveOps = computeWorkspaceFolderOps(currentFolders, [], BASE);
    const emptyRemovedPaths = emptyLiveOps.remove.map((i) => currentFolders[i].path);
    for (const f of userFolders) expect(emptyRemovedPaths).not.toContain(f.path);
  });
});
