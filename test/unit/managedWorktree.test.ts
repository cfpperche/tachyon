import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertManagedSlug,
  canMutateManagedWorktree,
  defaultChangeBranch,
  findManagedEntry,
  isUnderManagedBase,
  isUnderWorkspaceManagedRoot,
  liveFoldersFromRegistry,
  loadManagedWorktreeStore,
  ManagedWorktreeStoreError,
  newManagedId,
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
    expect(() => assertManagedSlug("../etc")).toThrow(/invalid managed worktree slug/);
  });

  it("defaultChangeBranch is deterministic", () => {
    expect(defaultChangeBranch("foo")).toBe("tachyon/change/foo");
  });

  it("isUnderManagedBase / isUnderWorkspaceManagedRoot", () => {
    const base = "/home/u/.cache/tachyon/worktrees";
    expect(isUnderManagedBase(path.join(base, "ws", "agent"), base)).toBe(true);
    expect(isUnderWorkspaceManagedRoot(path.join(base, "ws", "agent"), base, "ws")).toBe(true);
    expect(isUnderWorkspaceManagedRoot(path.join(base, "other", "agent"), base, "ws")).toBe(false);
    expect(isUnderWorkspaceManagedRoot(path.join(base, "ws"), base, "ws")).toBe(false);
  });

  it("newManagedId is injective for long colliding slug prefixes", () => {
    const a = "a".repeat(64);
    const b = "a".repeat(48) + "b".repeat(16);
    expect(newManagedId("change", a)).not.toBe(newManagedId("change", b));
  });

  it("canMutateManagedWorktree enforces owner vs privileged", () => {
    const entry: ManagedWorktreeEntry = {
      id: "mw-change-x",
      kind: "change",
      path: "/wt",
      branch: "b",
      baseRef: "h",
      tachyonCreatedBranch: true,
      createdBy: "alice",
      createdAt: "t",
      status: "active",
    };
    expect(canMutateManagedWorktree(entry, { kind: "agent", name: "alice" })).toBe(true);
    expect(canMutateManagedWorktree(entry, { kind: "agent", name: "bob" })).toBe(false);
    expect(canMutateManagedWorktree(entry, { kind: "legacy" })).toBe(true);
    expect(canMutateManagedWorktree(entry, { kind: "external" })).toBe(true);
  });

  it("load missing file is empty; corrupt file fails closed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mw-reg-"));
    const file = path.join(dir, "managed-worktrees.json");
    expect(loadManagedWorktreeStore(file).entries).toEqual([]);
    fs.writeFileSync(file, "{not-json");
    expect(() => loadManagedWorktreeStore(file)).toThrow(ManagedWorktreeStoreError);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, entries: [] }));
    expect(() => loadManagedWorktreeStore(file)).toThrow(/schemaVersion/);
    fs.rmSync(dir, { recursive: true, force: true });
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
    expect(liveFoldersFromRegistry(reloaded, () => true)).toEqual([{ path: entry.path, agent: "foo" }]);
    expect(liveFoldersFromRegistry(reloaded, () => false)).toEqual([]);
    const gone = removeManagedEntry(reloaded, entry.id);
    expect(findManagedEntry(gone, entry.id)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
