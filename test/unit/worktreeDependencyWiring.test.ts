import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager, resolveWorktreeCwd } from "../../src/worktree/WorktreeManager.js";
import { DEPENDENCY_DIR, describeDependencyState, shareDependencies } from "../../src/worktree/dependencySharing.js";
import { renderPrimer, PRIMER_LINE_BUDGET } from "../../src/bridge/primer.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

/**
 * t-3f93b4 — the wiring, on real git.
 *
 * `dependencySharing.test.ts` proves the DECISION. This file proves the decision is actually reached
 * at every door a launch comes through, because the measured defect was never a wrong decision — it
 * was no decision at all. A fresh worktree was born empty, the primer told its agent to run the
 * configured checks anyway, and three delegated children each answered that silence with their own
 * 478 MB `npm ci`.
 *
 * Doors covered here: create, relaunch (validated reuse), the settings opt-out, and the primer.
 */
describe("t-3f93b4 — dependency sharing reaches every launch door (real git, tmp repo)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  /** A repo whose committed tree carries a lockfile, plus an installed `node_modules` in the primary. */
  function mkRepo(lockBody = '{"lockfileVersion":3}'): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "wt-deps-repo-"));
    dirs.push(d);
    git(["init", "-b", "main"], d);
    git(["config", "user.email", "t@t.dev"], d);
    git(["config", "user.name", "T"], d);
    fs.writeFileSync(path.join(d, "package-lock.json"), lockBody);
    fs.writeFileSync(path.join(d, ".gitignore"), `${DEPENDENCY_DIR}\n`);
    git(["add", "-A"], d);
    git(["commit", "-m", "init"], d);
    fs.mkdirSync(path.join(d, DEPENDENCY_DIR));
    fs.writeFileSync(path.join(d, DEPENDENCY_DIR, "marker"), "installed-once-in-the-primary");
    return d;
  }

  function mgr(settings: TachyonConfig["settings"] = { worktree: { base } }): WorktreeManager {
    return new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, occupancy: async () => undefined });
  }

  function deps(m: WorktreeManager, settings: TachyonConfig["settings"], notices: string[]) {
    return {
      manager: m,
      settings,
      resolveParent: async () => ({ known: false }),
      runSetup: async () => {},
      shareDependencies: (worktreePath: string) => shareDependencies({ workspaceRoot: repo, worktreePath }),
      notify: (n: string) => notices.push(n),
    };
  }

  beforeEach(() => {
    repo = mkRepo();
    base = fs.mkdtempSync(path.join(os.tmpdir(), "wt-deps-base-"));
    dirs.push(base);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("CREATE: a fresh delegated worktree can resolve packages immediately, with no install and no bytes", async () => {
    // This is the DONE_WHEN, mechanized: the checkout git just made is usable by the commands the
    // primer tells its agent to run, without the agent doing anything first.
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const notices: string[] = [];
    const m = mgr(settings);

    const r = await resolveWorktreeCwd({ name: "child", worktree: true, temporary: true, isRestart: false }, deps(m, settings, notices));

    expect(r?.worktree?.dependencies?.mode).toBe("linked");
    const linked = path.join(r!.cwd, DEPENDENCY_DIR);
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(linked, "marker"), "utf8")).toBe("installed-once-in-the-primary");
    // Zero bytes: the entry is a link, and the linked tree is the primary's own, not a copy.
    expect(fs.lstatSync(linked).isDirectory()).toBe(false);
    // And it is invisible to git, so it can never be mistaken for the agent's work.
    expect(git(["status", "--porcelain=v1", "--untracked-files=all"], r!.cwd).trim()).toBe("");
  });

  it("CREATE: a branch whose committed lockfile differs is NOT linked, and the human hears why", async () => {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const notices: string[] = [];
    const m = mgr(settings);
    // A base branch that bumped a dependency — the child forks from it, so its checkout carries the
    // other lockfile from the very first moment.
    fs.writeFileSync(path.join(repo, "package-lock.json"), '{"lockfileVersion":3,"bumped":true}');
    git(["commit", "-am", "bump a dependency"], repo);
    // The primary's own working tree is put back, so only the CHILD's checkout diverges.
    const forked = git(["rev-parse", "HEAD"], repo).trim();
    git(["checkout", "-q", "-b", "old", `${forked}~1`], repo);

    const r = await resolveWorktreeCwd(
      { name: "child", worktree: true, temporary: true, branch: "child-branch", isRestart: false },
      deps(m, settings, notices),
    );
    // The child forks from `old`, so its lockfile equals the primary's — link. Now move the child's
    // checkout to the bumped lockfile the way a rebase would, and relaunch.
    expect(r?.worktree?.dependencies?.mode).toBe("linked");
    git(["merge", "--no-edit", "-q", forked], r!.cwd);
    await m.completePreparation(r!.worktree!);

    const notices2: string[] = [];
    const again = await resolveWorktreeCwd(
      { name: "child", worktree: true, temporary: true, branch: "child-branch", isRestart: true },
      { ...deps(m, settings, notices2), priorRecord: r!.worktree },
    );

    expect(again?.worktree?.dependencies?.mode).toBe("absent");
    expect(again?.worktree?.dependencies?.reason).toContain("package-lock.json");
    expect(fs.existsSync(path.join(again!.cwd, DEPENDENCY_DIR))).toBe(false);
    // Said OUT LOUD — the silence is the defect, so the notice is part of the contract.
    expect(notices2.join("\n")).toContain("no shared node_modules");
  });

  it("RELAUNCH: an unchanged lockfile keeps the link across restart", async () => {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const m = mgr(settings);
    const first = await resolveWorktreeCwd({ name: "child", worktree: true, temporary: true, isRestart: false }, deps(m, settings, []));
    await m.completePreparation(first!.worktree!);

    const again = await resolveWorktreeCwd(
      { name: "child", worktree: true, temporary: true, isRestart: true },
      { ...deps(m, settings, []), priorRecord: first!.worktree },
    );

    expect(again?.worktree?.dependencies?.mode).toBe("linked");
    expect(again?.worktree?.dependencies?.lockDigest).toBe(first!.worktree!.dependencies!.lockDigest);
  });

  it("RELAUNCH re-decides rather than carrying the prior record's claim forward", async () => {
    // The prior record says `linked`. If relaunch trusted it, a lockfile that moved in between would
    // be a stale claim the ledger keeps repeating — `t-b4a799`'s shape exactly.
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const m = mgr(settings);
    const first = await resolveWorktreeCwd({ name: "child", worktree: true, temporary: true, isRestart: false }, deps(m, settings, []));
    await m.completePreparation(first!.worktree!);
    fs.writeFileSync(path.join(first!.cwd, "package-lock.json"), '{"lockfileVersion":3,"agent-edited":true}');

    const again = await resolveWorktreeCwd(
      { name: "child", worktree: true, temporary: true, isRestart: true },
      { ...deps(m, settings, []), priorRecord: first!.worktree },
    );

    expect(first!.worktree!.dependencies!.mode).toBe("linked");
    expect(again?.worktree?.dependencies?.mode).toBe("absent");
    expect(again?.worktree?.dependencies?.lockDigest).not.toBe(first!.worktree!.dependencies!.lockDigest);
  });

  it("settings.worktree.shareDependencies: false opts a workspace out entirely", async () => {
    const settings: TachyonConfig["settings"] = { worktree: { base, shareDependencies: false } };
    const m = mgr(settings);

    const r = await resolveWorktreeCwd({ name: "child", worktree: true, temporary: true, isRestart: false }, deps(m, settings, []));

    expect(r?.worktree?.dependencies).toBeUndefined();
    expect(fs.existsSync(path.join(r!.cwd, DEPENDENCY_DIR))).toBe(false);
  });

  it("a caller that injects no sharing hook behaves exactly as it did before t-3f93b4", async () => {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const m = mgr(settings);
    const { shareDependencies: _omitted, ...withoutHook } = deps(m, settings, []);

    const r = await resolveWorktreeCwd({ name: "child", worktree: true, temporary: true, isRestart: false }, withoutHook);

    expect(r?.worktree?.dependencies).toBeUndefined();
    expect(fs.existsSync(path.join(r!.cwd, DEPENDENCY_DIR))).toBe(false);
  });
});

describe("t-3f93b4 — the primer stops being silent about it", () => {
  const verify = { full: "npm run verify:full", typecheck: "npm run typecheck", prepare: "npm ci --ignore-scripts" };

  it("a shared checkout is told the terms, right under the checks it is told to run", () => {
    const line = describeDependencyState({ mode: "linked", lockDigest: "d".repeat(64), reason: "lockfiles are identical to the primary checkout", at: "t" });
    const { primer } = renderPrimer({ agentName: "child", delegator: "coordinator", verify, dependencies: line });
    const lines = primer.split("\n");

    const checkIdx = lines.findIndex((l) => l.includes("typecheck: npm run typecheck"));
    const depsIdx = lines.findIndex((l) => l.startsWith("Dependencies:"));
    expect(checkIdx).toBeGreaterThan(-1);
    expect(depsIdx).toBe(checkIdx + 1); // the answer to "can I run those?" sits with the question
    expect(lines[depsIdx]).toContain("Do not reinstall through it");
  });

  it("a checkout that must install is told SO and WHY — the honest half of the DONE_WHEN", () => {
    const line = describeDependencyState(
      { mode: "absent", lockDigest: "d".repeat(64), reason: "this worktree adds pnpm-lock.yaml — this worktree needs its own dependencies", at: "t" },
      verify.prepare,
    );
    const { primer } = renderPrimer({ agentName: "child", delegator: "coordinator", verify, dependencies: line });

    expect(primer).toContain("this worktree has no node_modules");
    expect(primer).toContain("adds pnpm-lock.yaml");
    expect(primer).toContain("npm ci --ignore-scripts");
  });

  it("stays silent when nothing was measured — no line invented for a non-Node project", () => {
    const { primer } = renderPrimer({ agentName: "child", delegator: "coordinator", verify });
    expect(primer).not.toContain("Dependencies:");
  });

  it("the added line stays inside the primer's hard budget", () => {
    const line = describeDependencyState({ mode: "linked", lockDigest: "d".repeat(64), reason: "lockfiles are identical to the primary checkout", at: "t" });
    const { primer } = renderPrimer({ agentName: "child", delegator: "coordinator", verify, dependencies: line });
    expect(primer.split("\n").length).toBeLessThanOrEqual(PRIMER_LINE_BUDGET);
  });

  it("a dependency sentence carrying control characters is refused like every other primer fact", () => {
    expect(() => renderPrimer({ agentName: "child", verify, dependencies: "Dependencies: shared\u0007 (a bell smuggled in through an fs error string)" })).toThrow(/control characters/);
  });
});
