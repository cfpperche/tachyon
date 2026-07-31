import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  abandonMissingEntries,
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
import { ManagedWorktreeService } from "../../src/worktree/ManagedWorktreeService.js";
import { WorktreeManager } from "../../src/worktree/WorktreeManager.js";
import { pruneDeliveryRecord } from "../../src/git-delivery/prune.js";
import type { GitDelivery } from "../../src/git-delivery/types.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

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

  it("canMutateManagedWorktree enforces owner; shared tokens are not privileged", () => {
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
    expect(canMutateManagedWorktree(entry, { kind: "legacy" })).toBe(false);
    expect(canMutateManagedWorktree(entry, { kind: "external" })).toBe(false);
    expect(canMutateManagedWorktree(entry, { kind: "human" })).toBe(true);
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

  it("abandonMissingEntries marks missing actives abandoned; reappearance is not live until re-register", () => {
    const entry: ManagedWorktreeEntry = {
      id: "mw-change-gone",
      kind: "change",
      path: "/tmp/does-not-exist-managed-wt",
      branch: "b",
      baseRef: "h",
      tachyonCreatedBranch: true,
      slug: "gone",
      createdAt: "t",
      status: "active",
    };
    const { store, changed } = abandonMissingEntries(
      { schemaVersion: 1, entries: [entry] },
      (p) => p === "/tmp/reappeared-fake",
    );
    expect(changed).toBe(true);
    expect(store.entries[0]?.status).toBe("abandoned");
    // Even if pathExists later returns true for the old path, status stays abandoned so reveal stays off.
    expect(liveFoldersFromRegistry(store, () => true)).toEqual([]);
  });
});

/** Real-git composed coverage for ManagedWorktreeService + GitDelivery seam (spec 392 P2-1). */
describe("spec 392 ManagedWorktreeService (real git)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mw-svc-repo-"));
    dirs.push(d);
    git(["init", "-b", "main"], d);
    git(["config", "user.email", "t@t.dev"], d);
    git(["config", "user.name", "T"], d);
    fs.writeFileSync(path.join(d, "README.md"), "hi\n");
    git(["add", "-A"], d);
    git(["commit", "-m", "init"], d);
    return d;
  }

  function service(occupancy: () => Promise<undefined | { state: "live"; agent: string; cwd: string }> = async () => undefined) {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const manager = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      occupancy,
    });
    return new ManagedWorktreeService({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      manager,
      occupancy,
      now: () => "2026-07-16T12:00:00.000Z",
    });
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "mw-svc-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("createChange registers under managed base and list/get round-trip", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "t-hello", taskId: "t-abcdef", createdBy: "alice" });
    expect(entry.kind).toBe("change");
    expect(entry.slug).toBe("t-hello");
    expect(entry.path).toBe(path.join(base, "h", "change", "t-hello"));
    expect(fs.existsSync(entry.path)).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], entry.path).trim()).toBe("tachyon/change/t-hello");
    expect(svc.list({ kind: "change" })).toHaveLength(1);
    expect(svc.get(entry.id)?.path).toBe(entry.path);
  });

  /**
   * t-36182f — the wiring, not the module. A change worktree created through the service must come out
   * able to REACH the workspace's plugin tooling; before this, it came out with no `.tachyon/bin` at
   * all and a plugin doctor run inside it reported the tool as missing while it was installed and
   * healthy one directory over.
   */
  it("createChange projects the authority's plugin tooling by link, without copying it", async () => {
    // The authority is the repo the service manages; give it tooling to project.
    fs.mkdirSync(path.join(repo, ".tachyon", "bin"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".tachyon", "bin", "_tachyon-tool"), "#!/bin/sh\n", { mode: 0o700 });
    fs.mkdirSync(path.join(repo, ".claude", "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "skills", "demo", "SKILL.md"), "# demo\n");
    // Authority-only state that must NEVER be projected.
    fs.writeFileSync(path.join(repo, ".tachyon", "plugins.lock.json"), "{}\n");

    const svc = service();
    const entry = await svc.createChange({ slug: "tooling", createdBy: "alice" });

    const bin = path.join(entry.path, ".tachyon", "bin");
    expect(fs.lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(bin, "_tachyon-tool"))).toBe(true);
    // one binary on disk, not two
    expect(fs.realpathSync(bin)).toBe(fs.realpathSync(path.join(repo, ".tachyon", "bin")));
    // the pins stay in the authority alone
    expect(fs.existsSync(path.join(entry.path, ".tachyon", "plugins.lock.json"))).toBe(false);
    // t-62f599 — and NEITHER do the workspace's skills. The launcher is inert: something has to name
    // it. A skill tree is not — the runtime discovers it and offers it unasked, which is the whole
    // reason inheritance had to become opt-in.
    expect(fs.existsSync(path.join(entry.path, ".claude", "skills"))).toBe(false);
  });

  /**
   * t-62f599 — the trigger, which is where the first attempt at this actually failed.
   *
   * Withdrawing the skill projection shipped with its only trigger on `syncAgentRecord`, which fires on
   * spawn, fork and dismiss. A reload with agents already alive does NONE of those — it re-discovers
   * them. Measured after installing that build: all three live worktrees still had the links, so the
   * policy reached only agents somebody happened to restart, which is the opposite of a fleet-wide rule.
   */
  it("reprojectRegisteredWorktrees retires an inherited link on a plain reload, with no respawn", async () => {
    fs.mkdirSync(path.join(repo, ".claude", "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "skills", "demo", "SKILL.md"), "# demo\n");

    const svc = service();
    const entry = await svc.createChange({ slug: "reload", createdBy: "alice" });

    // Recreate exactly what a worktree from an earlier build carries.
    const skills = path.join(entry.path, ".claude", "skills");
    fs.mkdirSync(path.dirname(skills), { recursive: true });
    fs.symlinkSync(path.join(repo, ".claude", "skills"), skills);
    expect(fs.existsSync(skills)).toBe(true);

    // Activation only — no spawn, no fork, no register.
    await svc.reprojectRegisteredWorktrees();

    expect(fs.existsSync(skills)).toBe(false);
    // The authority is untouched, as always.
    expect(fs.existsSync(path.join(repo, ".claude", "skills", "demo", "SKILL.md"))).toBe(true);
  });

  it("remove refuses peer; human owner soft-removes clean tree and drops registry", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "own", createdBy: "alice" });
    const peer = await svc.remove(entry.id, { actor: { kind: "agent", name: "bob" } });
    expect(peer.removed).toBe(false);
    expect(peer.error).toMatch(/cannot remove/);
    expect(fs.existsSync(entry.path)).toBe(true);
    expect(svc.get(entry.id)).toBeDefined();

    const okRm = await svc.remove(entry.id, { actor: { kind: "human" } });
    expect(okRm.removed).toBe(true);
    expect(fs.existsSync(entry.path)).toBe(false);
    expect(svc.get(entry.id)).toBeUndefined();
  });

  it("authenticated coordinator retains authority to remove a stopped child worktree", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "child-seed", createdBy: "child" });
    svc.syncAgentRecord("child", {
      path: entry.path,
      branch: entry.branch,
      baseRef: entry.baseRef,
      tachyonCreatedBranch: entry.tachyonCreatedBranch,
      createdAt: entry.createdAt,
    }, "coordinator");
    // Later lifecycle syncs do not know the original caller, but must preserve its authority.
    svc.syncAgentRecord("child", {
      path: entry.path,
      branch: entry.branch,
      baseRef: entry.baseRef,
      tachyonCreatedBranch: entry.tachyonCreatedBranch,
      createdAt: entry.createdAt,
    });

    const managed = svc.list({ kind: "agent" })[0]!;
    expect(managed.createdBy).toBe("coordinator");
    expect((await svc.remove(managed.id, { actor: { kind: "agent", name: "peer" } })).removed).toBe(false);
    expect((await svc.remove(managed.id, { actor: { kind: "agent", name: "coordinator" } })).removed).toBe(true);
    expect(fs.existsSync(entry.path)).toBe(false);
  });

  it("dirty remove requires confirmDirty; registry survives refused remove", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "dirty", createdBy: "alice" });
    fs.writeFileSync(path.join(entry.path, "wip.txt"), "uncommitted\n");
    const soft = await svc.remove(entry.id, { actor: { kind: "agent", name: "alice" } });
    expect(soft.removed).toBe(false);
    expect(soft.error).toMatch(/dirty|confirmDirty/i);
    expect(svc.get(entry.id)).toBeDefined();

    const forced = await svc.remove(entry.id, {
      actor: { kind: "agent", name: "alice" },
      confirmDirty: true,
    });
    expect(forced.removed).toBe(true);
    expect(svc.get(entry.id)).toBeUndefined();
  });

  it("occupancy fail-closed blocks remove even with confirmDirty", async () => {
    let occ: { state: "live"; agent: string; cwd: string } | undefined;
    const svc = service(async () => occ);
    const entry = await svc.createChange({ slug: "busy", createdBy: "alice" });
    occ = { state: "live", agent: "other", cwd: entry.path };
    const out = await svc.remove(entry.id, {
      actor: { kind: "human" },
      confirmDirty: true,
    });
    expect(out.removed).toBe(false);
    expect(out.error).toMatch(/occupied/);
    expect(fs.existsSync(entry.path)).toBe(true);
    expect(svc.get(entry.id)).toBeDefined();
  });

  it("list reconciles missing paths to abandoned (not live reveal)", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "ghost", createdBy: "alice" });
    // Simulate catastrophic path loss without registry update.
    fs.rmSync(entry.path, { recursive: true, force: true });
    const listed = svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("abandoned");
    expect(svc.list({ status: "active" })).toHaveLength(0);
    // Reappearing directory at same path does not auto-reactivate.
    fs.mkdirSync(entry.path, { recursive: true });
    expect(svc.list({ status: "active" })).toHaveLength(0);
    expect(svc.get(entry.id)?.status).toBe("abandoned");
  });

  it("removePath engine: registered prune + unregistered force; occupancy never overridden", async () => {
    const svc = service(async () => undefined);
    const entry = await svc.createChange({ slug: "gd", createdBy: "orch" });
    const d: GitDelivery = {
      schemaVersion: 1,
      id: "gd-1",
      deliveryId: "d-managed-worktree",
      version: 1,
      workspaceId: "ws",
      createdBy: { kind: "agent", name: "orch" },
      agent: "orch",
      branchRef: entry.branch,
      worktreePath: entry.path,
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: git(["rev-parse", "HEAD"], entry.path).trim(),
      phase: "integrated",
      taskLinks: [],
      transitions: [],
      createdAt: "t",
      updatedAt: "t",
    };
    const pruned = await pruneDeliveryRecord(
      d,
      { id: d.id, expectedVersion: 1 },
      { kind: "agent", name: "orch" },
      {
        workspaceRoot: repo,
        git: async (args, cwd) => {
          try {
            const stdout = execFileSync("git", args, { cwd: cwd ?? repo, encoding: "utf8" });
            return { code: 0, stdout, stderr: "" };
          } catch (err) {
            const e = err as { status?: number; stdout?: string; stderr?: string };
            return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
          }
        },
        liveness: async () => "not_live",
        worktreeOccupancy: async () => undefined,
        removeManagedWorktree: (p, o) => svc.removePath(p, o),
      },
    );
    expect(pruned.result.ok).toBe(true);
    expect(svc.get(entry.id)).toBeUndefined();
    expect(fs.existsSync(entry.path)).toBe(false);

    // Occupied path: abandon flags must still refuse (no override).
    const entry2 = await svc.createChange({ slug: "gd2", createdBy: "orch" });
    const d2 = { ...d, id: "gd-2", worktreePath: entry2.path, branchRef: entry2.branch };
    const refused = await pruneDeliveryRecord(
      d2,
      { id: d2.id, expectedVersion: 1, abandon: true },
      { kind: "agent", name: "orch" },
      {
        workspaceRoot: repo,
        git: async (args, cwd) => {
          try {
            const stdout = execFileSync("git", args, { cwd: cwd ?? repo, encoding: "utf8" });
            return { code: 0, stdout, stderr: "" };
          } catch (err) {
            const e = err as { status?: number; stdout?: string; stderr?: string };
            return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
          }
        },
        liveness: async () => "not_live",
        worktreeOccupancy: async () => ({ state: "live", agent: "live-peer", cwd: entry2.path }),
        removeManagedWorktree: (p, o) => svc.removePath(p, o),
      },
    );
    expect(refused.result.ok).toBe(false);
    expect(refused.result.ok ? [] : refused.result.reasons.join(" ")).toMatch(/occupied/);
    expect(fs.existsSync(entry2.path)).toBe(true);
  });
});

/** spec 444 — listClassified() real-git integration (the classify.ts unit suite covers the pure logic). */
describe("spec 444 ManagedWorktreeService.listClassified (real git)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function mkRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mw-classify-repo-"));
    dirs.push(d);
    git(["init", "-b", "main"], d);
    git(["config", "user.email", "t@t.dev"], d);
    git(["config", "user.name", "T"], d);
    fs.writeFileSync(path.join(d, "README.md"), "hi\n");
    git(["add", "-A"], d);
    git(["commit", "-m", "init"], d);
    return d;
  }

  function service(occupancy: () => Promise<undefined | { state: "live"; agent: string; cwd: string }> = async () => undefined) {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const manager = new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, occupancy });
    return new ManagedWorktreeService({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, manager, occupancy });
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "mw-classify-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("t-9f8dfc: a fresh, clean, unoccupied change worktree classifies ready-to-remove", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "classify-clean", createdBy: "alice" });
    const [row] = await svc.listClassified({ kind: "change" });
    expect(row?.id).toBe(entry.id);
    expect(row?.classification.state).toBe("ready-to-remove");
    expect(row?.classification.containedInBase).toBe(true);
  });

  it("t-9f8dfc: an uncommitted change classifies needs-review with a stated reason", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "classify-dirty", createdBy: "alice" });
    fs.writeFileSync(path.join(entry.path, "wip.txt"), "uncommitted\n");
    const [row] = await svc.listClassified({ kind: "change" });
    expect(row?.classification.state).toBe("needs-review");
    expect(row?.classification.reasons.join(" ")).toMatch(/uncommitted/);
  });

  it("t-9f8dfc: a new commit ahead of base classifies needs-review with a commit count", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "classify-ahead", createdBy: "alice" });
    fs.writeFileSync(path.join(entry.path, "new.txt"), "unique work\n");
    git(["add", "-A"], entry.path);
    git(["commit", "-m", "unique work"], entry.path);
    const [row] = await svc.listClassified({ kind: "change" });
    expect(row?.classification.state).toBe("needs-review");
    expect(row?.classification.aheadOfBase).toBe(1);
    expect(row?.classification.containedInBase).toBe(false);
  });

  it("t-9f8dfc: a live occupant classifies occupied even on an otherwise-clean worktree", async () => {
    let occ: { state: "live"; agent: string; cwd: string } | undefined;
    const svc = service(async () => occ);
    const entry = await svc.createChange({ slug: "classify-occupied", createdBy: "alice" });
    occ = { state: "live", agent: "other", cwd: entry.path };
    const [row] = await svc.listClassified({ kind: "change" });
    expect(row?.classification.state).toBe("occupied");
    expect(row?.classification.occupant?.agent).toBe("other");
  });

  it("t-9f8dfc: an abandoned tombstone (path gone) classifies record-only, never ready-to-remove", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "classify-gone", createdBy: "alice" });
    fs.rmSync(entry.path, { recursive: true, force: true });
    const rows = await svc.listClassified({ kind: "change" });
    const row = rows.find((r) => r.id === entry.id);
    expect(row?.status).toBe("abandoned"); // reconcileStore flips it on the same list() pass
    expect(row?.classification.state).toBe("record-only");
    expect(row?.classification.pathExists).toBe(false);
  });

  it("t-6ae9a8 supersedes t-9f8dfc for a PROVABLE case: an unresolvable baseRef is reclaimable when HEAD is in the trunk", async () => {
    const svc = service();
    const entry = await svc.createChange({ slug: "classify-bad-base", createdBy: "alice" });
    // Simulate the real-world shape: a registered baseRef that no longer resolves (deleted branch,
    // gc'd SHA, typo at register time — spec 392's register() never validated it). rev-list fails
    // NON-throwing inside WorktreeManager.status; before the fix this read as 0-ahead => contained.
    const store = JSON.parse(fs.readFileSync(path.join(repo, ".tachyon", "managed-worktrees.json"), "utf8")) as {
      entries: Array<{ id: string; baseRef: string }>;
    };
    for (const e of store.entries) if (e.id === entry.id) e.baseRef = "refs/heads/never-existed";
    fs.writeFileSync(path.join(repo, ".tachyon", "managed-worktrees.json"), JSON.stringify({ schemaVersion: 1, entries: store.entries }, null, 2));

    const rows = await svc.listClassified({ kind: "change" });
    const row = rows.find((r) => r.id === entry.id);
    // t-9f8dfc established "unresolvable baseRef ⇒ never ready-to-remove". That rule was a PROXY for
    // "cannot prove safety", and the proxy is what t-6ae9a8 replaces: this worktree has no commits of
    // its own at all, so its HEAD is the trunk's, and removing it cannot lose anything regardless of
    // what its recorded base says. Refusing here would be refusing in the face of proof — and it is
    // precisely why eight landed worktrees piled up on this host.
    expect(row?.classification.state).toBe("ready-to-remove");
    expect(row?.classification.containedInBase).toBe(false); // the stale base still cannot be resolved
    expect(row?.classification.containedInTrunk).toBe(true); // but the trunk proves containment
  });

  it("t-9f8dfc's protection SURVIVES where it matters: unresolvable baseRef AND work not in the trunk", async () => {
    // The half of t-9f8dfc that is not superseded, kept as its own case so the blocker it fixed cannot
    // regress: with neither proof available, the classifier refuses and the gated removal refuses too.
    const svc = service();
    const entry = await svc.createChange({ slug: "classify-bad-base-unproven", createdBy: "alice" });
    execFileSync("git", ["checkout", "-q", "-b", "unproven-work"], { cwd: entry.path });
    fs.writeFileSync(path.join(entry.path, "never-landed.txt"), "not in base, not in trunk\n");
    execFileSync("git", ["add", "-A"], { cwd: entry.path });
    execFileSync("git", ["commit", "-q", "-m", "work in neither"], { cwd: entry.path });

    const store = JSON.parse(fs.readFileSync(path.join(repo, ".tachyon", "managed-worktrees.json"), "utf8")) as {
      entries: Array<{ id: string; baseRef: string }>;
    };
    for (const e of store.entries) if (e.id === entry.id) e.baseRef = "refs/heads/never-existed";
    fs.writeFileSync(path.join(repo, ".tachyon", "managed-worktrees.json"), JSON.stringify({ schemaVersion: 1, entries: store.entries }, null, 2));

    const rows = await svc.listClassified({ kind: "change" });
    const row = rows.find((r) => r.id === entry.id);
    expect(row?.classification.state).toBe("needs-review");
    expect(row?.classification.containedInBase).toBe(false);
    expect(row?.classification.containedInTrunk).toBe(false);

    // Defense-in-depth, unchanged: the classification-gated removal refuses and the checkout survives.
    const refused = await svc.removeClassified(entry.id, { actor: { kind: "human" } });
    expect(refused.removed).toBe(false);
    expect(refused.error).toMatch(/not ready-to-remove/);
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it("t-9f8dfc: removeClassified removes a genuinely-safe checkout and refuses one that turned dirty since render", async () => {
    const svc = service();
    const clean = await svc.createChange({ slug: "rc-clean", createdBy: "alice" });
    const turnsDirty = await svc.createChange({ slug: "rc-dirty", createdBy: "alice" });
    // State changed between the UI's render-time verdict and the click: re-validation must refuse.
    fs.writeFileSync(path.join(turnsDirty.path, "wip.txt"), "uncommitted\n");

    const ok = await svc.removeClassified(clean.id, { actor: { kind: "human" } });
    expect(ok.removed).toBe(true);
    expect(fs.existsSync(clean.path)).toBe(false);

    const refused = await svc.removeClassified(turnsDirty.id, { actor: { kind: "human" } });
    expect(refused.removed).toBe(false);
    expect(refused.error).toMatch(/uncommitted/);
    expect(fs.existsSync(turnsDirty.path)).toBe(true);
  });
});
