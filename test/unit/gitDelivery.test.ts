import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";
import { containedInBase, hygieneReport } from "../../src/git-delivery/classify.js";
import { canPruneGitDelivery } from "../../src/git-delivery/policy.js";
import { pruneDeliveryRecord } from "../../src/git-delivery/prune.js";
import { resolveGitDeliverySettings } from "../../src/git-delivery/settings.js";
import { GitDeliveryStore, GitDeliveryVersionConflictError, GitDeliveryUniquenessError } from "../../src/git-delivery/store.js";
import type { GitDelivery } from "../../src/git-delivery/types.js";
import type { GitExec, GitResult } from "../../src/worktree/WorktreeManager.js";

const actor = { kind: "agent" as const, name: "owner" };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-gd-"));
}

function baseDelivery(overrides: Partial<GitDelivery> = {}): GitDelivery {
  return {
    schemaVersion: 1,
    id: "gd-a1",
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

describe("GitDelivery store (spec 365)", () => {
  it("writes records atomically enough for reload and enforces version CAS", async () => {
    const root = tmpRoot();
    const store = new GitDeliveryStore(root, { id: () => "gd-111111", now: () => "2026-07-09T00:00:00.000Z" });
    const rec = await store.open({
      workspaceId: "ws",
      createdBy: actor,
      agent: "worker",
      branchRef: "tachyon/worker",
      worktreePath: "/wt/worker",
      tachyonCreatedBranch: true,
      baseRef: "main",
    });
    expect(rec.version).toBe(1);
    expect(fs.existsSync(path.join(root, ".tachyon", "git-deliveries", "gd-111111.json"))).toBe(true);
    await expect(store.update(rec.id, 2, (r) => r)).rejects.toBeInstanceOf(GitDeliveryVersionConflictError);
    const next = await store.update(rec.id, 1, (r) => ({ ...r, phase: "abandoned" }));
    expect(next.version).toBe(2);
  });

  it("keeps at most one non-pruned delivery per branch/worktree", async () => {
    const store = new GitDeliveryStore(tmpRoot(), { id: () => "gd-111111" });
    await store.open({ workspaceId: "ws", createdBy: actor, agent: "a", branchRef: "b", worktreePath: "/wt/a", tachyonCreatedBranch: true, baseRef: "main" });
    await expect(store.open({ workspaceId: "ws", createdBy: actor, agent: "b", branchRef: "b", worktreePath: "/wt/b", tachyonCreatedBranch: true, baseRef: "main" })).rejects.toBeInstanceOf(GitDeliveryUniquenessError);
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
    const out = await pruneDeliveryRecord(d, { id: d.id, expectedVersion: 1 }, actor, { workspaceRoot: root, git: fake, liveness: async () => "live" });
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
    const out = await pruneDeliveryRecord(d, { id: d.id, expectedVersion: 1 }, actor, { workspaceRoot: root, git: fake, liveness: async () => "not_live", now: () => "now" });
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
    const out = await pruneDeliveryRecord(d, { id: d.id, expectedVersion: 1, abandon: true }, actor, { workspaceRoot: root, git: fake, liveness: async () => "not_live" });
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
    });
    expect(out.result).toMatchObject({ ok: true, removedWorktree: false, deletedBranch: false });
    expect(out.next?.phase).toBe("pruned");
  });
});

describe("GitDelivery settings", () => {
  it("parses profiles and explicit overrides", () => {
    const { config, errors } = parseConfig("agents:\n  a:\n    cmd: claude\nsettings:\n  gitDelivery:\n    profile: solo\n    autoOpen: true\n    prunePrincipals: [orch]\n");
    expect(errors).toEqual([]);
    expect(resolveGitDeliverySettings(config?.settings as TachyonConfig["settings"])).toMatchObject({ profile: "solo", autoOpen: true, prunePrincipals: ["orch"] });
  });
});

describe("GitDelivery actor policy", () => {
  it("allows owner/creator/allowlist prune, but refuses a random peer", () => {
    const d = baseDelivery({ agent: "worker", createdBy: { kind: "agent", name: "orch" } });
    expect(canPruneGitDelivery(d, "worker", [])).toBe(true);
    expect(canPruneGitDelivery(d, "orch", [])).toBe(true);
    expect(canPruneGitDelivery(d, "ops", ["ops"])).toBe(true);
    expect(canPruneGitDelivery(d, "peer", [])).toBe(false);
    expect(canPruneGitDelivery(d, undefined, ["peer"])).toBe(false);
  });
});
