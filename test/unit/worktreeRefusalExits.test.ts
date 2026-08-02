/**
 * t-dcdb7f — condition-list refusals must name a reachable EXIT, not only the why.
 *
 * This is the non-enum half of t-2600f8 / t-0cbcbd: prune and worktree occupancy refusals were
 * lists of unsatisfied conditions with no forward step. The contract under test is behavioural:
 * each family carries an actionable exit for its condition, and the surfaced exit CHANGES when
 * the blocking condition changes. Exact string pins are avoided so wording can tighten without
 * losing the invariant.
 *
 * Surfaces: WorktreeManager.remove occupancy, classifyManagedWorktree reasons, and the
 * ManagedWorktreeService wrappers that concatenate them for Bridge/UI callers.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tempDir.js";
import { classifyManagedWorktree, type ClassifyWorktreeDeps } from "../../src/worktree/classify.js";
import { ManagedWorktreeService } from "../../src/worktree/ManagedWorktreeService.js";
import {
  WorktreeManager,
  type GitExec,
  type GitResult,
  type WorktreeOccupancy,
  type WorktreeStatus,
} from "../../src/worktree/WorktreeManager.js";
import type { ManagedWorktreeEntry } from "../../src/worktree/managedWorktree.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function entry(over: Partial<ManagedWorktreeEntry> = {}): ManagedWorktreeEntry {
  return {
    id: "mw-change-x",
    kind: "change",
    path: "/wt/x",
    branch: "tachyon/change/x",
    baseRef: "main",
    tachyonCreatedBranch: true,
    createdAt: "2026-07-24T00:00:00.000Z",
    status: "active",
    ...over,
  };
}

function cleanStatus(aheadOfBase = 0): WorktreeStatus {
  return {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    detached: false,
    branch: "tachyon/change/x",
    aheadOfBase,
    unpushed: aheadOfBase,
    hasUpstream: false,
  };
}

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

function fakeGit(script: Record<string, GitResult>): GitExec {
  return async (args) => {
    const key = args.join(" ");
    return script[key] ?? script["*"] ?? { code: 1, stdout: "", stderr: `unexpected git: ${key}` };
  };
}

function deps(over: Partial<ClassifyWorktreeDeps> & { status: ClassifyWorktreeDeps["status"] }): ClassifyWorktreeDeps {
  return { pathExists: () => true, ...over };
}

/** A refusal line carries an exit when something after the why points at a next step. */
function assertNamesExit(message: string, exitShape: RegExp, label: string): void {
  expect(message, `${label}: empty refusal`).not.toBe("");
  expect(message, `${label}: must name an exit (${exitShape})`).toMatch(exitShape);
}

describe("t-dcdb7f — classify reasons name a reachable exit", () => {
  it("occupied names who to stop, not only who is there", async () => {
    const occupant: WorktreeOccupancy = { state: "live", agent: "codex", cwd: "/wt/x" };
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => cleanStatus(0), occupancy: async () => occupant }),
    );
    expect(result.state).toBe("occupied");
    const reason = result.reasons[0] ?? "";
    expect(reason).toMatch(/occupied by 'codex'/);
    assertNamesExit(reason, /kill_agent|stop agent 'codex'|wait until it leaves/, "occupied");
  });

  it("dirty names confirmDirty / commit-or-discard, not only the dirt", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => ({ ...cleanStatus(0), unstaged: 2 }) }),
    );
    const reason = result.reasons[0] ?? "";
    expect(reason).toMatch(/uncommitted changes/);
    assertNamesExit(reason, /confirmDirty|commit or discard/, "dirty");
  });

  it("uncontained commits name land/integrate, not only the count", async () => {
    const gitExec = fakeGit({
      "rev-parse HEAD": ok("deadbeef"),
      "cherry main deadbeef": ok("+ deadbeef unique"),
      "rev-parse --verify main^{commit}": ok("mainsha"),
      "merge-base --is-ancestor deadbeef mainsha": { code: 1, stdout: "", stderr: "" },
      "cherry mainsha deadbeef": ok("+ deadbeef unique"),
    });
    const result = await classifyManagedWorktree(
      entry(),
      deps({ git: gitExec, status: async () => cleanStatus(1), trunkRef: "main" }),
    );
    expect(result.state).toBe("needs-review");
    const reason = result.reasons[0] ?? "";
    expect(reason).toMatch(/not contained/);
    assertNamesExit(reason, /land|integrate/, "uncontained");
  });

  it("status-probe failure names how to re-measure or force knowingly", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ status: async () => { throw new Error("git binary missing"); } }),
    );
    const reason = result.reasons[0] ?? "";
    expect(reason).toMatch(/status probe failed/);
    assertNamesExit(reason, /fix git|confirmDirty|measure/, "status-failed");
  });

  it("record-only names registry reconcile, not a force-remove that cannot apply", async () => {
    const result = await classifyManagedWorktree(
      entry(),
      deps({ pathExists: () => false, status: async () => { throw new Error("must not be called"); } }),
    );
    const reason = result.reasons[0] ?? "";
    expect(reason).toMatch(/path does not exist/);
    assertNamesExit(reason, /abandoned|host UI|list worktrees/, "record-only");
  });

  it("when dirty AND uncontained, dirty leads — the first exit is the one that blocks first", async () => {
    const gitExec = fakeGit({
      "rev-parse HEAD": ok("deadbeef"),
      "cherry main deadbeef": ok("+ deadbeef unique"),
      "rev-parse --verify main^{commit}": ok("mainsha"),
      "merge-base --is-ancestor deadbeef mainsha": { code: 1, stdout: "", stderr: "" },
      "cherry mainsha deadbeef": ok("+ deadbeef unique"),
    });
    const result = await classifyManagedWorktree(
      entry(),
      deps({
        git: gitExec,
        status: async () => ({ ...cleanStatus(1), unstaged: 1 }),
        trunkRef: "main",
      }),
    );
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons[0]).toMatch(/uncommitted changes/);
    assertNamesExit(result.reasons[0]!, /confirmDirty|commit or discard/, "primary-dirty");
    // Second family still carries its own exit (full list for diagnostics); primary is what surfaces.
    assertNamesExit(result.reasons[1]!, /land|integrate/, "secondary-uncontained");
  });
});

describe("t-dcdb7f — WorktreeManager occupancy refusals name an exit", () => {
  let repo: string;
  let base: string;
  let recPath: string;

  beforeEach(() => {
    repo = makeTempDir("tachyon-occ-exit-repo-");
    base = makeTempDir("tachyon-occ-exit-base-");
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.dev"], repo);
    git(["config", "user.name", "T"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "init"], repo);
    recPath = path.join(base, "h", "agent-x");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  function rec() {
    return {
      path: recPath,
      branch: "tachyon/agent-x",
      tachyonCreatedBranch: true,
      baseRef: "main",
      createdAt: "2026-07-24T00:00:00.000Z",
    };
  }

  it("missing probe names host wiring / human — not a silent dead end", async () => {
    const manager = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => ({ worktree: { base } }),
      // occupancy deliberately omitted
    });
    const out = await manager.remove(rec(), false, { force: true });
    expect(out.removed).toBe(false);
    expect(out.error).toMatch(/no occupancy probe configured/);
    assertNamesExit(out.error!, /human|host wiring|cannot force past occupancy/, "no-probe");
  });

  it("probe error names retry and that force cannot bypass occupancy", async () => {
    const manager = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => ({ worktree: { base } }),
      occupancy: async () => {
        throw new Error("tmux did not answer");
      },
    });
    const out = await manager.remove(rec(), false, { force: true });
    expect(out.removed).toBe(false);
    expect(out.error).toMatch(/tmux did not answer/);
    assertNamesExit(out.error!, /retry|measurable|cannot force past occupancy/, "probe-error");
  });

  it("live occupant names kill_agent / wait — and the exit changes when the agent name changes", async () => {
    let agent = "alpha";
    const manager = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => ({ worktree: { base } }),
      occupancy: async () => ({ state: "live", agent, cwd: recPath }),
    });
    const first = await manager.remove(rec(), false, { force: true });
    expect(first.removed).toBe(false);
    expect(first.error).toMatch(/occupied by agent 'alpha'/);
    assertNamesExit(first.error!, /kill_agent|stop agent 'alpha'|wait until it leaves/, "occupied-alpha");

    agent = "beta";
    const second = await manager.remove(rec(), false, { force: true });
    expect(second.error).toMatch(/occupied by agent 'beta'/);
    assertNamesExit(second.error!, /stop agent 'beta'|kill_agent/, "occupied-beta");
    // Exit names the current blocker, not a stale one.
    expect(second.error).not.toMatch(/stop agent 'alpha'/);
  });
});

describe("t-dcdb7f — ManagedWorktreeService surfaces the primary blocking exit", () => {
  let repo: string;
  let base: string;

  beforeEach(() => {
    repo = makeTempDir("tachyon-svc-exit-repo-");
    base = makeTempDir("tachyon-svc-exit-base-");
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.dev"], repo);
    git(["config", "user.name", "T"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "init"], repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  function service(occupancy: () => Promise<WorktreeOccupancy | undefined> = async () => undefined) {
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
    });
  }

  it("removeClassified on dirty names confirmDirty exit (not only needs-review)", async () => {
    const svc = service();
    const created = await svc.createChange({ slug: "dirty-exit", createdBy: "alice" });
    fs.writeFileSync(path.join(created.path, "wip.txt"), "uncommitted\n");

    const refused = await svc.removeClassified(created.id, { actor: { kind: "human" } });
    expect(refused.removed).toBe(false);
    expect(refused.error).toMatch(/not ready-to-remove/);
    expect(refused.error).toMatch(/uncommitted changes/);
    assertNamesExit(refused.error!, /confirmDirty|commit or discard/, "removeClassified-dirty");
  });

  it("removeClassified on occupied names kill_agent; dirty co-conditions do not bury the occupancy exit", async () => {
    let occ: WorktreeOccupancy | undefined = {
      state: "live",
      agent: "worker",
      cwd: "/x",
    };
    const svc = service(async () => occ);
    const created = await svc.createChange({ slug: "occ-exit", createdBy: "alice" });
    fs.writeFileSync(path.join(created.path, "wip.txt"), "also dirty\n");

    const refused = await svc.removeClassified(created.id, { actor: { kind: "human" } });
    expect(refused.removed).toBe(false);
    expect(refused.error).toMatch(/occupied/);
    assertNamesExit(refused.error!, /kill_agent|stop agent 'worker'|wait until it leaves/, "removeClassified-occupied");
    // Primary block is occupancy — do not dump the full multi-reason list past it.
    expect(refused.error).not.toMatch(/uncommitted changes/);

    // Condition change: free the occupant but leave dirty → exit switches to dirty family.
    occ = undefined;
    const dirty = await svc.removeClassified(created.id, { actor: { kind: "human" } });
    expect(dirty.removed).toBe(false);
    expect(dirty.error).toMatch(/uncommitted changes/);
    assertNamesExit(dirty.error!, /confirmDirty|commit or discard/, "removeClassified-after-free");
    expect(dirty.error).not.toMatch(/occupied/);
  });

  it("owner-only remove refusal names owner / host / lineage alternative", async () => {
    const svc = service();
    const created = await svc.createChange({ slug: "auth-exit", createdBy: "alice" });

    const refused = await svc.remove(created.id, {
      actor: { kind: "agent", name: "stranger" },
      confirmDirty: true,
    });
    expect(refused.removed).toBe(false);
    expect(refused.error).toMatch(/caller cannot remove/);
    expect(refused.error).toMatch(/alice/);
    assertNamesExit(refused.error!, /host human|lineage|owner|drop confirmDirty/, "caller-cannot-remove");
  });

  it("reconcileHygiene refusal carries the same dirty exit as removeClassified", async () => {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const occupancy = async () => undefined;
    const manager = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      occupancy,
    });
    const svc = new ManagedWorktreeService({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      manager,
      occupancy,
      lineage: { parentOf: (name) => (name === "worker" ? "coordinator" : undefined) },
    });
    const created = await svc.createChange({ slug: "sweep-exit", createdBy: "worker" });
    fs.writeFileSync(path.join(created.path, "wip.txt"), "x\n");

    const report = await svc.reconcileHygiene({
      actor: { kind: "agent", name: "coordinator" },
      deleteBranch: true,
    });
    expect(report.removed).toEqual([]);
    const reason = report.refused[0]?.reason ?? "";
    expect(reason).toMatch(/uncommitted changes/);
    assertNamesExit(reason, /confirmDirty|commit or discard/, "reconcile-dirty");
  });
});
