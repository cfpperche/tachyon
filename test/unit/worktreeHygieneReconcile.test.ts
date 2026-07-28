/**
 * t-e74631 — the hygiene sweep against a REAL git repo, not fakes.
 *
 * The task widens WHO may ask for a change worktree to be removed: a delegating parent, not just the
 * creator. That widening is only defensible if it buys no new power over the work itself, so the
 * thing these cases actually pin is the negative: an ancestor with full authority still cannot remove
 * a worktree holding uncommitted changes or unique commits. Fakes could not prove that — the proof
 * IS git's ancestry, so the repo is real.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tempDir.js";
import { HYGIENE_AUDIT_REL, ManagedWorktreeService } from "../../src/worktree/ManagedWorktreeService.js";
import { WorktreeManager, type WorktreeOccupancy } from "../../src/worktree/WorktreeManager.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo plus a service whose lineage says `worker`'s parent is `coordinator`. */
function fixture(opts: { occupancy?: (p: string) => Promise<WorktreeOccupancy | undefined> } = {}) {
  const repo = makeTempDir("tachyon-hygiene-repo-");
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t.dev"], repo);
  git(["config", "user.name", "T"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "init"], repo);

  const base = makeTempDir("tachyon-hygiene-base-");
  const settings: TachyonConfig["settings"] = { worktree: { base } };
  // An UNOCCUPIED probe, not an absent one, and wired into BOTH seams the way Workspace wires them.
  // The manager fail-closes on a missing probe ("occupancy unknown"), so leaving either side out
  // would make the negative cases below pass for a reason that has nothing to do with the feature.
  const occupancy = opts.occupancy ?? (async () => undefined);
  const manager = new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, occupancy });
  const svc = new ManagedWorktreeService({
    workspaceRoot: repo, wsHash: "h", getSettings: () => settings, manager, occupancy,
    lineage: { parentOf: (name) => (name === "worker" ? "coordinator" : undefined) },
  });
  return { repo, base, manager, svc };
}

const coordinator = { kind: "agent", name: "coordinator" } as const;

describe("hygiene reconciliation (t-e74631)", () => {
  it("removes a landed change worktree for the delegating PARENT, which is the residue that accumulated", async () => {
    const { repo, svc } = fixture();
    const entry = await svc.createChange({ slug: "landed-work", createdBy: "worker" });
    expect(fs.existsSync(entry.path)).toBe(true);

    // `coordinator` never created this and is not its agent — under the old creator-only rule it had
    // no way to clean up after a child that has since finished.
    const report = await svc.reconcileHygiene({ actor: coordinator, deleteBranch: true });

    expect(report.removed.map((r) => r.id)).toEqual([entry.id]);
    expect(report.removed[0]).toMatchObject({ relation: "ancestor" });
    expect(fs.existsSync(entry.path)).toBe(false);

    // The audit is the part a later reader has to be able to trust: who asked, whose it was, by what
    // relation, and what was true at the time.
    const audit = fs.readFileSync(path.join(repo, HYGIENE_AUDIT_REL), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      id: entry.id, actor: "coordinator", relation: "ancestor", owner: "worker",
      lineage: ["worker", "coordinator"],
      proofs: { state: "ready-to-remove", dirty: false, tachyonCreatedBranch: true },
    });
  });

  it("still refuses a worktree carrying UNIQUE COMMITS, ancestor authority notwithstanding", async () => {
    const { svc } = fixture();
    const entry = await svc.createChange({ slug: "unique-work", createdBy: "worker" });
    fs.writeFileSync(path.join(entry.path, "unique.txt"), "irreplaceable work\n");
    git(["add", "-A"], entry.path);
    git(["commit", "-m", "unique unmerged work"], entry.path);

    const report = await svc.reconcileHygiene({ actor: coordinator, deleteBranch: true });

    // Authority was granted and the removal STILL did not happen. That is the whole safety argument.
    expect(report.removed).toEqual([]);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]).toMatchObject({ id: entry.id, relation: "ancestor" });
    expect(report.refused[0]!.reason).toContain("not contained in base");
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it("still refuses a DIRTY worktree, and never force-removes on a sweep", async () => {
    const { svc } = fixture();
    const entry = await svc.createChange({ slug: "dirty-work", createdBy: "worker" });
    fs.writeFileSync(path.join(entry.path, "wip.txt"), "uncommitted\n");

    const report = await svc.reconcileHygiene({ actor: coordinator, deleteBranch: true });

    expect(report.removed).toEqual([]);
    expect(report.refused[0]!.reason).toContain("uncommitted changes");
    expect(fs.existsSync(entry.path)).toBe(true);
    expect(fs.readFileSync(path.join(entry.path, "wip.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("still refuses an OCCUPIED worktree, because a live agent's cwd is never yanked", async () => {
    const occupied = fixture({ occupancy: async () => ({ agent: "worker", cwd: "/x", state: "live" }) as WorktreeOccupancy });
    const entry = await occupied.svc.createChange({ slug: "occupied-work", createdBy: "worker" });

    const report = await occupied.svc.reconcileHygiene({ actor: coordinator, deleteBranch: true });

    expect(report.removed).toEqual([]);
    expect(report.refused[0]!.reason).toContain("occupied");
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it("reports every refusal with a reason rather than skipping it silently", async () => {
    // The old failure mode was invisibility: residue built up because nothing said anything. A sweep
    // that quietly did nothing would reproduce it in a new place.
    const { svc } = fixture();
    const clean = await svc.createChange({ slug: "clean-one", createdBy: "worker" });
    const dirty = await svc.createChange({ slug: "dirty-one", createdBy: "worker" });
    fs.writeFileSync(path.join(dirty.path, "wip.txt"), "x\n");

    const report = await svc.reconcileHygiene({ actor: coordinator, deleteBranch: true });

    expect(report.scanned).toBe(2);
    expect(report.removed.map((r) => r.id)).toEqual([clean.id]);
    expect(report.refused.map((r) => r.id)).toEqual([dirty.id]);
    for (const refusal of report.refused) expect(refusal.reason ?? "").not.toBe("");
  });

  it("dry run reports the same verdict and touches nothing", async () => {
    const { repo, svc } = fixture();
    const entry = await svc.createChange({ slug: "preview-work", createdBy: "worker" });

    const preview = await svc.reconcileHygiene({ actor: coordinator, deleteBranch: true, dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.removed.map((r) => r.id)).toEqual([entry.id]);
    expect(fs.existsSync(entry.path)).toBe(true);
    // A preview is not an event: it must not leave an audit line claiming a removal happened.
    expect(fs.existsSync(path.join(repo, HYGIENE_AUDIT_REL))).toBe(false);

    const real = await svc.reconcileHygiene({ actor: coordinator, deleteBranch: true });
    expect(real.removed.map((r) => r.id)).toEqual([entry.id]);
    expect(fs.existsSync(entry.path)).toBe(false);
  });

  it("removes nothing for an agent outside the lineage", async () => {
    const { svc } = fixture();
    const entry = await svc.createChange({ slug: "not-yours", createdBy: "worker" });

    const report = await svc.reconcileHygiene({ actor: { kind: "agent", name: "stranger" }, deleteBranch: true });

    expect(report.removed).toEqual([]);
    expect(report.refused[0]!.reason).toContain("neither the owner");
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it("never sweeps an AGENT worktree, even for the workspace authority", async () => {
    // An agent's working home is not residue. The sweep filters by kind, so this holds regardless of
    // how wide the caller's authority is.
    const { manager, svc } = fixture();
    const ensured = await manager.ensure({ agent: "worker", branch: "tachyon/worker" });
    svc.syncAgentRecord("worker", ensured.record, "worker");
    const home = svc.list({ kind: "agent" })[0]!;
    const change = await svc.createChange({ slug: "sweepable", createdBy: "worker" });

    const report = await svc.reconcileHygiene({ actor: { kind: "human" }, deleteBranch: true });

    expect(report.scanned).toBe(1);
    expect(report.removed.map((r) => r.id)).toEqual([change.id]);
    expect(fs.existsSync(home.path)).toBe(true);
  });
});
