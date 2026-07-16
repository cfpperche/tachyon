import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertManagedSlug,
  defaultChangeBranch,
  findManagedEntry,
  isUnderManagedBase,
  liveFoldersFromRegistry,
  loadManagedWorktreeStore,
  pathForChange,
  removeManagedEntry,
  saveManagedWorktreeStore,
  upsertManagedEntry,
  type ManagedWorktreeEntry,
} from "../../src/worktree/managedWorktree.js";

describe("spec 392 managed worktree registry", () => {
  it("pathForChange is under base/wsHash/change/slug", () => {
    expect(pathForChange("/cache/wt", "abc123", "t-hello")).toBe(
      path.join("/cache/wt", "abc123", "change", "t-hello"),
    );
  });

  it("assertManagedSlug accepts safe ids and rejects junk", () => {
    expect(assertManagedSlug("t-689e6c")).toBe("t-689e6c");
    expect(assertManagedSlug("feat_hooks.v2")).toBe("feat_hooks.v2");
    expect(() => assertManagedSlug("../etc")).toThrow(/invalid managed worktree slug/);
    expect(() => assertManagedSlug("")).toThrow(/invalid managed worktree slug/);
  });

  it("defaultChangeBranch is deterministic", () => {
    expect(defaultChangeBranch("foo")).toBe("tachyon/change/foo");
  });

  it("isUnderManagedBase mirrors workspaceFolderOps containment", () => {
    const base = "/home/u/.cache/tachyon/worktrees";
    expect(isUnderManagedBase(path.join(base, "ws", "agent"), base)).toBe(true);
    expect(isUnderManagedBase(base, base)).toBe(false);
    expect(isUnderManagedBase("/other", base)).toBe(false);
  });

  it("upsert/find/remove round-trip on disk store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mw-reg-"));
    const file = path.join(dir, "managed-worktrees.json");
    const entry: ManagedWorktreeEntry = {
      id: "mw-change-foo",
      kind: "change",
      path: path.join(dir, "wt"),
      branch: "tachyon/change/foo",
      baseRef: "abc",
      tachyonCreatedBranch: true,
      slug: "foo",
      createdAt: "2026-07-16T00:00:00.000Z",
      status: "active",
    };
    let store = loadManagedWorktreeStore(file);
    store = upsertManagedEntry(store, entry);
    saveManagedWorktreeStore(file, store);
    const reloaded = loadManagedWorktreeStore(file);
    expect(findManagedEntry(reloaded, entry.id)?.path).toBe(entry.path);
    expect(findManagedEntry(reloaded, entry.path)?.id).toBe(entry.id);
    expect(liveFoldersFromRegistry(reloaded)).toEqual([{ path: entry.path, agent: "foo" }]);
    const gone = removeManagedEntry(reloaded, entry.id);
    expect(findManagedEntry(gone, entry.id)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("upsert by path replaces prior entry for same checkout", () => {
    const entry1: ManagedWorktreeEntry = {
      id: "mw-agent-a",
      kind: "agent",
      path: "/wt/a",
      branch: "tachyon/a",
      baseRef: "1",
      tachyonCreatedBranch: true,
      agent: "a",
      createdAt: "t0",
      status: "active",
    };
    const entry2: ManagedWorktreeEntry = {
      ...entry1,
      id: "mw-agent-a2",
      baseRef: "2",
    };
    let store = upsertManagedEntry({ schemaVersion: 1, entries: [] }, entry1);
    store = upsertManagedEntry(store, entry2);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.baseRef).toBe("2");
  });
});
