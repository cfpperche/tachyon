import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { containedInBase, hygieneReport } from "../../src/git-delivery/classify.js";
import { pruneDeliveryRecord } from "../../src/git-delivery/prune.js";
import { resolveGitDeliverySettings } from "../../src/git-delivery/settings.js";
import { deterministicGitDeliveryId, GitDeliveryStore, GitDeliveryUniquenessError } from "../../src/git-delivery/store.js";
import type { GitDelivery } from "../../src/git-delivery/types.js";
import type { GitExec, GitResult } from "../../src/worktree/WorktreeManager.js";
import { makeTempDir } from "../helpers/tempDir.js";

const actor = { kind: "agent" as const, name: "owner" };

function tmpRoot(): string {
  return makeTempDir("tachyon-gd-");
}

function baseDelivery(overrides: Partial<GitDelivery> = {}): GitDelivery {
  return {
    schemaVersion: 1,
    id: "gd-a1",
    deliveryId: "d-a1",
    version: 1,
    workspaceId: "ws",
    createdBy: actor,
    agent: "worker",
    branchRef: "tachyon/worker",
    worktreePath: "/wt/worker",
    tachyonCreatedBranch: true,
    baseRef: "main",
    currentHeadSha: "tip",
    phase: "open",
    taskLinks: [],
    transitions: [],
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function git(script: Record<string, GitResult | ((args: string[], cwd: string) => GitResult)>): GitExec {
  return async (args, cwd) => {
    const key = args.join(" ");
    const hit = script[key] ?? script["*"];
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected git: ${key} @ ${cwd}` };
    return typeof hit === "function" ? hit(args, cwd) : hit;
  };
}

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = ""): GitResult => ({ code: 1, stdout: "", stderr });

describe("GitDelivery canonical projection store", () => {
  it("derives one deterministic projection id and persists only the linked SQLite row", async () => {
    const root = tmpRoot();
    const store = new GitDeliveryStore(root, { now: () => "2026-07-09T00:00:00.000Z" });
    const rec = await store.open({
      workspaceId: "ws", deliveryId: "d-canonical", createdBy: actor, agent: "worker",
      branchRef: "tachyon/worker", worktreePath: "/wt/worker", tachyonCreatedBranch: true, baseRef: "main",
    });
    expect(rec).toMatchObject({ id: deterministicGitDeliveryId("d-canonical"), deliveryId: "d-canonical", version: 1 });
    expect(await store.list()).toEqual([rec]);
    expect(fs.existsSync(path.join(root, ".tachyon", "git-deliveries"))).toBe(false);
  });

  it("refuses an empty Delivery link or caller-selected projection id", async () => {
    const store = new GitDeliveryStore(tmpRoot());
    const input = {
      workspaceId: "ws", deliveryId: "d-canonical", createdBy: actor, agent: "worker",
      branchRef: "tachyon/worker", worktreePath: "/wt/worker", tachyonCreatedBranch: true, baseRef: "main",
    };
    await expect(store.open({ ...input, deliveryId: "" })).rejects.toThrow(/Delivery id is required/);
    await expect(store.open({ ...input, id: "gd-cafecafe" })).rejects.toThrow(/expected deterministic id/);
    expect(await store.list()).toEqual([]);
  });

  it("keeps at most one canonical projection per branch/worktree", async () => {
    const store = new GitDeliveryStore(tmpRoot());
    await store.open({ workspaceId: "ws", deliveryId: "d-a", createdBy: actor, agent: "a", branchRef: "b", worktreePath: "/wt/a", tachyonCreatedBranch: true, baseRef: "main" });
    await expect(store.open({ workspaceId: "ws", deliveryId: "d-b", createdBy: actor, agent: "b", branchRef: "b", worktreePath: "/wt/b", tachyonCreatedBranch: true, baseRef: "main" })).rejects.toBeInstanceOf(GitDeliveryUniquenessError);
  });

  it("replays canonical open only when every immutable creation fact matches", async () => {
    const store = new GitDeliveryStore(tmpRoot());
    const input = {
      workspaceId: "ws",
      deliveryId: "d-replay",
      createdBy: actor,
      agent: "worker",
      branchRef: "tachyon/worker",
      worktreePath: "/wt/replay",
      tachyonCreatedBranch: true,
      baseRef: "main",
      currentHeadSha: "old-head",
    };
    const original = await store.open(input);

    for (const altered of [
      { workspaceId: "other-ws" },
      { createdBy: { kind: "agent" as const, name: "other-owner" } },
      { tachyonCreatedBranch: false },
      { baseRef: "release" },
    ]) {
      await expect(store.open({ ...input, ...altered })).rejects.toBeInstanceOf(GitDeliveryUniquenessError);
      expect(await store.get(original.id)).toEqual(original);
    }

    // The branch head is mutable state, not creation authority. Replaying open returns the
    // durable row; the canonical intent application updates the head in its sequenced step.
    await expect(store.open({ ...input, currentHeadSha: "new-head" })).resolves.toEqual(original);
  });
});

describe("GitDelivery containment and hygiene", () => {
  it("containedInBase accepts ancestry", async () => {
    const d = baseDelivery();
    await expect(containedInBase(d, "tip", { workspaceRoot: "/repo", git: git({ "merge-base --is-ancestor tip main": ok() }) })).resolves.toBe(true);
  });

  it("containedInBase accepts cherry-empty only when integration metadata exists", async () => {
    const d = baseDelivery({ integration: { kind: "cherry-pick", at: "t", integratedSha: "landed" } });
    const fake = git({
      "merge-base --is-ancestor tip main": fail(),
      "merge-base --is-ancestor landed main": ok(),
      "cherry main tip": ok(""),
    });
    await expect(containedInBase(d, "tip", { workspaceRoot: "/repo", git: fake })).resolves.toBe(true);
    await expect(containedInBase({ ...d, integration: undefined }, "tip", { workspaceRoot: "/repo", git: fake })).resolves.toBe(false);
  });

  it("reports ready_to_prune, missing_ref, integrated_unverified, and linked landed_without_integrated without mutating", async () => {
    const root = tmpRoot();
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    const d1 = baseDelivery({ id: "gd-ready", phase: "integrated", worktreePath: wt });
    const d2 = baseDelivery({ id: "gd-missing", branchRef: "missing", worktreePath: path.join(root, "gone") });
    const d3 = baseDelivery({ id: "gd-unverified", phase: "integrated_unverified", worktreePath: wt });
    const d4 = baseDelivery({ id: "gd-task", branchRef: "tachyon/task", currentHeadSha: "task-tip", taskLinks: [{ taskId: "t-abc123", linkedAt: "t" }], worktreePath: wt });
    const report = await hygieneReport([d1, d2, d3, d4], [], {
      workspaceRoot: root,
      git: git({
        "show-ref --verify --quiet refs/heads/tachyon/worker": ok(),
        "show-ref --verify --quiet refs/heads/tachyon/task": ok(),
        "show-ref --verify --quiet refs/heads/missing": fail(),
        "rev-parse tachyon/worker": ok("tip\n"),
        "rev-parse tachyon/task": ok("task-tip\n"),
        "status --porcelain=v1 --untracked-files=all": ok(""),
        "merge-base --is-ancestor tip main": ok(),
        "merge-base --is-ancestor task-tip main": fail(),
        "*": fail(),
      }),
      liveness: async () => "not_live",
      tasks: { get: () => ({ id: "t-abc123", status: "landed" }) } as never,
      reloadSnapshot: {
        classifications: [{ deliveryId: "d-a1", class: "terminal", reason: "test" }],
        byId: new Map([["d-a1", { deliveryId: "d-a1", class: "terminal", reason: "test" }]]),
        unavailableAgents: new Set(),
      },
    });
    expect(report.findings.map((f) => f.category)).toContain("ready_to_prune");
    expect(report.findings.map((f) => f.category)).toContain("missing_ref");
    expect(report.findings.map((f) => f.category)).toContain("integrated_unverified");
    expect(report.findings.some((f) => f.category === "landed_without_integrated" && f.taskId === "t-abc123")).toBe(true);
  });
});

describe("GitDelivery prune", () => {
  it("refuses live or dirty integrated deliveries before deleting", async () => {
    const root = tmpRoot();
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    const d = baseDelivery({ phase: "integrated", worktreePath: wt });
    const calls: string[] = [];
    const fake: GitExec = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "show-ref" || args[0] === "rev-parse" || args[0] === "merge-base") return ok(args[0] === "rev-parse" ? "tip\n" : "");
      if (args[0] === "status") return ok(" M file.ts\n");
      if (args[0] === "worktree" && args[1] === "list") return ok(`worktree ${wt}\nbranch refs/heads/tachyon/worker\n`);
      return fail();
    };
    const out = await pruneDeliveryRecord(d, { id: d.id, expectedVersion: 1 }, actor, { workspaceRoot: root, git: fake, liveness: async () => "live", worktreeOccupancy: async () => undefined });
    expect(out.result.ok).toBe(false);
    expect(calls).not.toContain(`worktree remove --force ${wt}`);
  });

  it("prunes a git-verified integrated delivery and transitions to pruned", async () => {
    const root = tmpRoot();
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    const d = baseDelivery({ phase: "integrated", worktreePath: wt });
    const calls: string[] = [];
    const fake: GitExec = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "show-ref" || args[0] === "merge-base") return ok();
      if (args[0] === "rev-parse") return ok("tip\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "worktree" && args[1] === "list") return ok(`worktree ${wt}\nbranch refs/heads/tachyon/worker\n`);
      if (args[0] === "worktree" && args[1] === "remove") return ok();
      if (args[0] === "branch" && args[1] === "-d") return ok();
      return ok();
    };
    const out = await pruneDeliveryRecord(d, { id: d.id, expectedVersion: 1 }, actor, { workspaceRoot: root, git: fake, liveness: async () => "not_live", worktreeOccupancy: async () => undefined, now: () => "now" });
    expect(out.result).toMatchObject({ ok: true, removedWorktree: true, deletedBranch: true });
    expect(out.next?.phase).toBe("pruned");
    expect(calls).toContain(`worktree remove --force ${wt}`);
    expect(calls).toContain("branch -d tachyon/worker");
  });

  it("abandon mode removes the worktree but keeps a branch with unique commits by default", async () => {
    const root = tmpRoot();
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    const d = baseDelivery({ phase: "abandoned", worktreePath: wt });
    const calls: string[] = [];
    const fake = git({
      "show-ref --verify --quiet refs/heads/tachyon/worker": ok(),
      "rev-parse tachyon/worker": ok("tip\n"),
      "status --porcelain=v1 --untracked-files=all": ok(""),
      "merge-base --is-ancestor tip main": fail(),
      "worktree list --porcelain": ok(`worktree ${wt}\nbranch refs/heads/tachyon/worker\n`),
      [`worktree remove --force ${wt}`]: () => {
        calls.push("remove");
        return ok();
      },
      "worktree prune": ok(),
    });
    const out = await pruneDeliveryRecord(d, { id: d.id, expectedVersion: 1, abandon: true }, actor, { workspaceRoot: root, git: fake, liveness: async () => "not_live", worktreeOccupancy: async () => undefined });
    expect(out.result).toMatchObject({ ok: true, removedWorktree: true, deletedBranch: false });
    expect(calls).toEqual(["remove"]);
  });

  it("closes missing_ref without deleting git objects", async () => {
    const root = tmpRoot();
    const d = baseDelivery({ phase: "open", worktreePath: path.join(root, "gone") });
    const out = await pruneDeliveryRecord(d, { id: d.id, expectedVersion: 1 }, actor, {
      workspaceRoot: root,
      git: git({
        "show-ref --verify --quiet refs/heads/tachyon/worker": fail(),
        "worktree list --porcelain": ok(""),
        "*": fail(),
      }),
      liveness: async () => "not_live",
      worktreeOccupancy: async () => undefined,
    });
    expect(out.result).toMatchObject({ ok: true, removedWorktree: false, deletedBranch: false });
    expect(out.next?.phase).toBe("pruned");
  });

  it("refuses to remove a worktree path registered to a different branch", async () => {
    const root = tmpRoot();
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    const d = baseDelivery({ phase: "integrated", worktreePath: wt });
    const calls: string[] = [];
    const fake: GitExec = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "show-ref" || args[0] === "merge-base") return ok();
      if (args[0] === "rev-parse") return ok("tip\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "worktree" && args[1] === "list") return ok(`worktree ${wt}\nbranch refs/heads/tachyon/other\n`);
      return fail();
    };
    const out = await pruneDeliveryRecord(d, { id: d.id, expectedVersion: 1 }, actor, { workspaceRoot: root, git: fake, liveness: async () => "not_live", worktreeOccupancy: async () => undefined });
    expect(out.result).toMatchObject({ ok: false });
    expect(out.result.ok ? [] : out.result.reasons).toContain("worktree path is not registered for branch refs/heads/tachyon/worker");
    expect(calls).not.toContain(`worktree remove --force ${wt}`);
  });
});

describe("GitDelivery settings", () => {
  it("contains only linked-projection authority lists", () => {
    expect(resolveGitDeliverySettings({ gitDelivery: { prunePrincipals: ["orch"], integratePrincipals: ["release"] } }))
      .toEqual({ prunePrincipals: ["orch"], integratePrincipals: ["release"] });
  });
});

describe("GitDelivery actor policy", () => {
  it("linked policy never grants integrate/prune by agent or createdBy equality", async () => {
    const { canIntegrateLinkedGitDelivery, canPruneLinkedGitDelivery } = await import("../../src/git-delivery/policy.js");
    expect(canIntegrateLinkedGitDelivery({ kind: "agent", name: "worker" }, [])).toBe(false);
    expect(canPruneLinkedGitDelivery({ kind: "agent", name: "worker" }, [])).toBe(false);
    expect(canPruneLinkedGitDelivery({ kind: "agent", name: "orch" }, ["orch"], { kind: "agent", name: "orch" })).toBe(true);
    expect(canIntegrateLinkedGitDelivery({ kind: "human" }, [], { kind: "human" })).toBe(true);
    expect(canPruneLinkedGitDelivery({ kind: "system" }, [], { kind: "system" })).toBe(true);
    expect(canPruneLinkedGitDelivery({ kind: "human" }, [], { kind: "legacy" })).toBe(false);
  });
});

describe("GitDelivery canonical sequence apply (T15)", () => {
  it("applies the next sequence, replays identically, and refuses gaps/collisions/link retarget", async () => {
    const root = tmpRoot();
    const store = new GitDeliveryStore(root, { now: () => "2026-07-12T00:00:00.000Z" });
    const rec = await store.open({
      workspaceId: "ws", createdBy: actor, deliveryId: "d-1", agent: "worker",
      branchRef: "b", worktreePath: "/wt/c", tachyonCreatedBranch: true, baseRef: "main",
    });
    const applied = await store.applyCanonicalIntent({
      id: rec.id, expectedVersion: rec.version, sequence: 1, operationId: "op-1", deliveryId: "d-1",
      mutate: (r) => ({ ...r, phase: "accepted" }),
    });
    expect(applied.lastAppliedProjectionSequence).toBe(1);
    expect(applied.phase).toBe("accepted");
    const replay = await store.applyCanonicalIntent({
      id: rec.id, expectedVersion: applied.version, sequence: 1, operationId: "op-1", deliveryId: "d-1",
      mutate: (r) => ({ ...r, phase: "integrated" }),
    });
    expect(replay.phase).toBe("accepted");
    await expect(store.applyCanonicalIntent({
      id: rec.id, expectedVersion: applied.version, sequence: 1, operationId: "op-OTHER", deliveryId: "d-1",
      mutate: (r) => r,
    })).rejects.toThrow(/already applied/);
    await expect(store.applyCanonicalIntent({
      id: rec.id, expectedVersion: applied.version, sequence: 3, operationId: "op-3", deliveryId: "d-1",
      mutate: (r) => r,
    })).rejects.toThrow(/gap/);
    await expect(store.applyCanonicalIntent({
      id: rec.id, expectedVersion: applied.version, sequence: 2, operationId: "op-2", deliveryId: "d-OTHER",
      mutate: (r) => r,
    })).rejects.toThrow(/link drift|deliveryId/);
  });
});
