import { describe, expect, it } from "vitest";
import { computeWorkspaceFolderOps } from "../../src/workspace/workspaceFolderOps.js";

const BASE = "/home/goat/.cache/tachyon/worktrees/ws1";

describe("computeWorkspaceFolderOps", () => {
  it("adds a live worktree not yet present as a folder", () => {
    const ops = computeWorkspaceFolderOps([], [{ path: `${BASE}/alpha`, agent: "alpha" }], BASE);
    expect(ops).toEqual({ add: [{ path: `${BASE}/alpha`, name: "alpha" }], remove: [] });
  });

  it("is idempotent — an already-present live worktree is not re-added", () => {
    const ops = computeWorkspaceFolderOps(
      [{ path: `${BASE}/alpha`, name: "alpha" }],
      [{ path: `${BASE}/alpha`, agent: "alpha" }],
      BASE,
    );
    expect(ops.add).toEqual([]);
  });

  it("removes a folder under the base once its worktree is no longer live", () => {
    const ops = computeWorkspaceFolderOps([{ path: `${BASE}/alpha`, name: "alpha" }], [], BASE);
    expect(ops.remove).toEqual([0]);
  });

  it("removes an orphan folder under the base with no live worktree (post-reload self-heal)", () => {
    const ops = computeWorkspaceFolderOps(
      [{ path: `${BASE}/orphan`, name: "orphan" }],
      [{ path: `${BASE}/other`, agent: "other" }],
      BASE,
    );
    expect(ops.remove).toEqual([0]);
    expect(ops.add).toEqual([{ path: `${BASE}/other`, name: "other" }]);
  });

  it("never returns a remove index for a folder outside worktreesBase, even with no live worktrees", () => {
    const userFolders = [
      { path: "/home/goat/tachyon", name: "tachyon" },
      { path: "/home/goat/tachyon-plugins", name: "tachyon-plugins" },
    ];
    const ops = computeWorkspaceFolderOps(userFolders, [], BASE);
    expect(ops.remove).toEqual([]);
  });

  it("does not treat the base directory itself as a folder under the base", () => {
    const ops = computeWorkspaceFolderOps([{ path: BASE, name: "ws1" }], [], BASE);
    expect(ops.remove).toEqual([]);
  });

  it("tolerates a trailing slash on either side when comparing paths", () => {
    const ops = computeWorkspaceFolderOps(
      [{ path: `${BASE}/alpha/`, name: "alpha" }],
      [{ path: `${BASE}/alpha`, agent: "alpha" }],
      `${BASE}/`,
    );
    expect(ops).toEqual({ add: [], remove: [] });
  });

  it("handles a mix: add a new one, remove a cleaned one, keep an existing one, never touch user folders", () => {
    const currentFolders = [
      { path: "/home/goat/tachyon", name: "tachyon" },
      { path: `${BASE}/alpha`, name: "alpha" },
      { path: `${BASE}/bravo`, name: "bravo" },
    ];
    const liveWorktrees = [
      { path: `${BASE}/alpha`, agent: "alpha" },
      { path: `${BASE}/charlie`, agent: "charlie" },
    ];
    const ops = computeWorkspaceFolderOps(currentFolders, liveWorktrees, BASE);
    expect(ops.add).toEqual([{ path: `${BASE}/charlie`, name: "charlie" }]);
    expect(ops.remove).toEqual([2]);
  });
});
