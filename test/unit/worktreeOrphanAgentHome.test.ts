/**
 * t-621613 — an agent worktree entry whose agent NO LONGER EXISTS, against a real git repo.
 *
 * The measured state: a registry entry of `kind: "agent"`, a checkout, and a branch, with no row in
 * `sessions.json` and no declaration in `tachyon.yml`. Every door refused it. The doors that work by
 * NAME (UI delete, dismiss_agent, Agent Studio → Forget, kill_agent) all need a roster or ledger row
 * to even find the agent, and the doors that work by ID refused on authority: `canMutateManagedWorktree`
 * grants the creator or the agent itself, and both of those are the agent that is gone. Cleanup on
 * 2026-08-02 was therefore `git worktree remove --force` + `git branch -D` + editing the registry
 * JSON by hand — three raw operations where the product promises one governed one.
 *
 * What these cases pin is the NARROWNESS of the grant, not its existence. The refusal that protects a
 * live agent's home from its own lineage is deliberate and stays; the only thing that changes is what
 * happens when the home has nobody in it. So every case below that grants is matched by one that
 * refuses for a reason that has nothing to do with authority — presence unproved, owner alive, tree
 * dirty, checkout occupied.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tempDir.js";
import { HYGIENE_AUDIT_REL, ManagedWorktreeService } from "@tachyon/engine/worktree/ManagedWorktreeService.js";
import { WorktreeManager, type WorktreeOccupancy } from "@tachyon/engine/worktree/WorktreeManager.js";
import type { OwnerPresence } from "@tachyon/engine/worktree/hygieneAuthority.js";
import type { TachyonConfig } from "@tachyon/engine/config/loadConfig.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A repo, a service, and a roster seam that answers for `ghost` however the case needs. `worker` is
 * always present, so every case has a live agent to contrast against.
 */
function fixture(opts: {
  ghost?: OwnerPresence | (() => Promise<OwnerPresence>);
  occupancy?: (p: string) => Promise<WorktreeOccupancy | undefined>;
  /** Omitted entirely when false — the state every caller that predates t-621613 is in. */
  wireRoster?: boolean;
} = {}) {
  const repo = makeTempDir("tachyon-orphan-repo-");
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t.dev"], repo);
  git(["config", "user.name", "T"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "init"], repo);

  const base = makeTempDir("tachyon-orphan-base-");
  const settings: TachyonConfig["settings"] = { worktree: { base } };
  const occupancy = opts.occupancy ?? (async () => undefined);
  const manager = new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, occupancy });
  const ledgerCleared: string[] = [];
  const ghost = opts.ghost ?? "absent";
  const svc = new ManagedWorktreeService({
    workspaceRoot: repo, wsHash: "h", getSettings: () => settings, manager, occupancy,
    lineage: { parentOf: (name) => (name === "ghost" ? "coordinator" : undefined) },
    onAgentWorktreeRemoved: (agent) => ledgerCleared.push(agent),
    ...(opts.wireRoster === false ? {} : {
      ownerPresence: async (agent: string): Promise<OwnerPresence> => {
        if (agent !== "ghost") return "present";
        return typeof ghost === "function" ? await ghost() : ghost;
      },
    }),
  });
  return { repo, base, manager, svc, ledgerCleared };
}

/** The real orphan state: entry + checkout + branch, and nothing anywhere else that knows the name. */
async function orphanHome(f: ReturnType<typeof fixture>, agent = "ghost") {
  const ensured = await f.manager.ensure({ agent, branch: `tachyon/${agent}` });
  f.svc.syncAgentRecord(agent, ensured.record);
  const entry = f.svc.list({ kind: "agent" }).find((e) => e.agent === agent)!;
  expect(fs.existsSync(entry.path)).toBe(true);
  return entry;
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(["rev-parse", "--verify", `refs/heads/${branch}`], repo);
    return true;
  } catch {
    return false;
  }
}

const stranger = { kind: "agent", name: "stranger" } as const;

describe("orphan agent worktree entry (t-621613)", () => {
  it("is removed WHOLE by one governed call — checkout, branch and registry entry", async () => {
    const f = fixture();
    const entry = await orphanHome(f);
    expect(branchExists(f.repo, entry.branch)).toBe(true);

    const result = await f.svc.removeClassified(entry.id, { actor: stranger, deleteBranch: true });

    expect(result.removed).toBe(true);
    // All three of the things that had to be done by hand, done by the one call.
    expect(fs.existsSync(entry.path)).toBe(false);
    expect(branchExists(f.repo, entry.branch)).toBe(false);
    expect(f.svc.list({ kind: "agent" })).toEqual([]);
    // And the ledger is told, so the two records cannot diverge the way t-05dff5 measured.
    expect(f.ledgerCleared).toEqual(["ghost"]);

    // The audit records the RELATION, so a later reader can see this was granted because nobody
    // lived here — not because someone had ownership they should not have had.
    const audit = fs.readFileSync(path.join(f.repo, HYGIENE_AUDIT_REL), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      id: entry.id, actor: "stranger", relation: "orphan", owner: "ghost",
      proofs: { state: "ready-to-remove", dirty: false },
    });
  });

  it("FAIL-BEFORE: with no roster seam wired, the same call refuses exactly as it always did", async () => {
    // This is the state of every caller that predates the change, and of a headless service that has
    // no roster to ask. Presence unmeasured is presence unproved, and unproved must not grant.
    const f = fixture({ wireRoster: false });
    const entry = await orphanHome(f);

    const result = await f.svc.removeClassified(entry.id, { actor: stranger, deleteBranch: true });

    expect(result.removed).toBe(false);
    expect(result.error).toContain("agent worktree");
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it("refuses while the agent is STILL ALIVE — the refusal this task must not weaken", async () => {
    // The whole point of the distinction: a home with an inhabitant is not residue, and no ancestor,
    // peer or stranger inherits authority over it. `coordinator` is even `ghost`'s lineage parent
    // here, which is the exact grant the change worktree rule would give and this one must not.
    const f = fixture({ ghost: "present" });
    const entry = await orphanHome(f);

    for (const actor of [stranger, { kind: "agent", name: "coordinator" } as const]) {
      const result = await f.svc.removeClassified(entry.id, { actor, deleteBranch: true });
      expect(result.removed, `${actor.name} must not remove a live agent's home`).toBe(false);
      expect(result.error).toContain("agent worktree");
    }
    expect(fs.existsSync(entry.path)).toBe(true);
    expect(f.svc.list({ kind: "agent" })).toHaveLength(1);
  });

  it("refuses when presence is UNKNOWN, and when the roster probe throws", async () => {
    // An ambiguous tmux read, an unreadable forget receipt, a seam that blew up: all the same answer.
    for (const ghost of ["unknown" as const, () => Promise.reject<OwnerPresence>(new Error("roster unreadable"))]) {
      const f = fixture({ ghost });
      const entry = await orphanHome(f);
      const result = await f.svc.removeClassified(entry.id, { actor: stranger, deleteBranch: true });
      expect(result.removed).toBe(false);
      expect(result.error).toContain("agent worktree");
      expect(fs.existsSync(entry.path)).toBe(true);
    }
  });

  it("still refuses a DIRTY orphan home: the grant buys the right to ask, never to force", async () => {
    const f = fixture();
    const entry = await orphanHome(f);
    fs.writeFileSync(path.join(entry.path, "wip.txt"), "work nobody has seen\n");

    const result = await f.svc.removeClassified(entry.id, { actor: stranger, deleteBranch: true });

    expect(result.removed).toBe(false);
    expect(result.error).toContain("uncommitted changes");
    // Authority WAS granted and the removal still did not happen — the same safety shape t-e74631 has.
    expect(result.authority).toMatchObject({ allowed: true, relation: "orphan" });
    expect(fs.readFileSync(path.join(entry.path, "wip.txt"), "utf8")).toBe("work nobody has seen\n");
  });

  it("still refuses an OCCUPIED orphan home, because the roster is not the only lock", async () => {
    // Belt and braces on purpose: if the roster is ever wrong about a name, a process actually
    // sitting in the checkout still refuses. Two independent proofs, not one.
    const f = fixture({ occupancy: async () => ({ agent: "ghost", cwd: "/x", state: "live" }) as WorktreeOccupancy });
    const entry = await orphanHome(f);

    const result = await f.svc.removeClassified(entry.id, { actor: stranger, deleteBranch: true });

    expect(result.removed).toBe(false);
    expect(result.error).toContain("occupied");
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it("is never picked up by the unattended sweep, orphan or not", async () => {
    // The sweep runs at activation, which is exactly when a spawning agent's registry entry can exist
    // before its ledger row does. Naming the entry is a deliberate act; sweeping is not.
    const f = fixture();
    const entry = await orphanHome(f);
    const change = await f.svc.createChange({ slug: "landed", createdBy: "ghost" });

    const report = await f.svc.reconcileHygiene({ actor: { kind: "human" }, deleteBranch: true });

    expect(report.scanned).toBe(1);
    expect(report.removed.map((r) => r.id)).toEqual([change.id]);
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it("the host human reaches it the way they always could, and the audit says workspace", async () => {
    // The human arm is decided before any of this, so an orphan changes nothing for them here. It is
    // the UI operation that gates on `kind: "agent"`; that gate is proved in workspaceHeadless.
    const f = fixture({ ghost: "present" });
    const entry = await orphanHome(f);

    const result = await f.svc.removeClassified(entry.id, { actor: { kind: "human" }, deleteBranch: true });

    expect(result.removed).toBe(true);
    expect(result.authority).toMatchObject({ allowed: true, relation: "workspace" });
  });
});
