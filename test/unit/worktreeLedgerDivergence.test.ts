/**
 * t-05dff5 — ONE checkout, TWO records, TWO doors.
 *
 * A Saved Agent's worktree is claimed in two places: the managed-worktree registry (Control →
 * Worktrees) and the session ledger's `worktree` block (the agent card). Each door used to update
 * only its own record, and the pair could disagree: removing through Control → Worktrees left the
 * ledger owning a directory that no longer existed, and nothing governed could then release it —
 * forget refused ("still owns a worktree") and the agent-card removal died on `git worktree remove`
 * (`is not a working tree`) BEFORE it reached `clearWorktree`.
 *
 * Both halves are proved here against a REAL git repository, because the whole question is what git
 * actually does to a checkout that is already gone:
 *  1. Control → Worktrees on an agent entry clears the ledger claim too.
 *  2. The agent card recovers a checkout that is already absent instead of throwing.
 *  3. A removal that fails for a REAL reason (a locked worktree) still fails, and both records keep
 *     their claim — "already absent" is measured, never inferred from a git error.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeAgentWorktree, type AgentWorktreeRemovalPorts } from "../../src/agents/agentRemovalCascade.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { ManagedWorktreeService, agentWorktreePath } from "../../src/worktree/ManagedWorktreeService.js";
import { WorktreeManager, type WorktreeRecord } from "../../src/worktree/WorktreeManager.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

const AGENT = "claude-validador";
const dirs: string[] = [];

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A real repo, a real managed base, and the two records wired the way `Workspace` wires them. */
function harness() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "t05dff5-repo-"));
  dirs.push(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t.dev"], repo);
  git(["config", "user.name", "T"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "init"], repo);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "t05dff5-base-"));
  dirs.push(base);
  const settings: TachyonConfig["settings"] = { worktree: { base } };
  const occupancy = async () => undefined;
  const manager = new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, occupancy });
  const ledger = new SessionLedger(repo);
  const managed = new ManagedWorktreeService({
    workspaceRoot: repo,
    wsHash: "h",
    getSettings: () => settings,
    manager,
    occupancy,
    // exactly the wiring under test, as `Workspace` declares it
    onAgentWorktreeRemoved: (agent: string) => ledger.clearWorktree(agent),
  });
  return { repo, settings, manager, ledger, managed };
}

/** Give `AGENT` a real checkout, claimed in BOTH records. */
function giveAgentAWorktree(h: ReturnType<typeof harness>): WorktreeRecord {
  const wtPath = agentWorktreePath(h.settings, "h", AGENT);
  const branch = `tachyon/${AGENT}`;
  git(["worktree", "add", "-b", branch, wtPath, "main"], h.repo);
  const rec: WorktreeRecord = {
    path: wtPath,
    branch,
    tachyonCreatedBranch: true,
    baseRef: git(["rev-parse", "main"], h.repo).trim(),
    createdAt: new Date().toISOString(),
  };
  // A Saved Agent's row carries its definition, so clearing the worktree claim leaves a real row
  // behind (a row holding nothing but a worktree would simply vanish, and prove nothing here).
  h.ledger.record(AGENT, { cwd: wtPath, worktree: rec, def: { cmd: "claude", kind: "agent" } });
  h.managed.syncAgentRecord(AGENT, rec);
  return rec;
}

/** The slice of the engine the agent-card door touches; only the two records are real. */
function cardPorts(h: ReturnType<typeof harness>): AgentWorktreeRemovalPorts {
  return {
    manager: {
      liveDescendants: async () => [],
      probeAgentOccupancy: async () => ({ state: "free" as const }),
      kill: async () => undefined,
      releaseOwnedWorktreeForRemoval: async () => undefined,
    },
    ledger: h.ledger,
    worktrees: h.manager,
    managedWorktrees: h.managed,
  };
}

describe("t-05dff5: a worktree removal leaves one story behind it", () => {
  it("Control → Worktrees on an agent entry clears the ledger claim, not just the registry", async () => {
    const h = harness();
    const rec = giveAgentAWorktree(h);
    const entry = h.managed.list({ kind: "agent" })[0]!;
    expect(h.ledger.get(AGENT)?.worktree?.path).toBe(rec.path);

    const out = await h.managed.removeClassified(entry.id, { actor: { kind: "human" } });

    expect(out.removed).toBe(true);
    expect(fs.existsSync(rec.path)).toBe(false);
    expect(h.managed.get(entry.id)).toBeUndefined();
    // The row SURVIVES — only the claim on a checkout that no longer exists goes away.
    expect(h.ledger.get(AGENT)).toBeDefined();
    expect(h.ledger.get(AGENT)?.worktree).toBeUndefined();
  });

  it("the agent card recovers a checkout that is already gone instead of throwing", async () => {
    const h = harness();
    const rec = giveAgentAWorktree(h);
    // The other door already took the checkout (the measured state of this workspace: the ledger
    // still owns a path that is neither on disk nor a worktree of this repository).
    git(["worktree", "remove", rec.path], h.repo);
    expect(h.ledger.get(AGENT)?.worktree?.path).toBe(rec.path);

    // The measurement itself: git refuses, and the refusal is proved to mean "nothing left here".
    const probed = await h.manager.remove(rec, false);
    expect(probed.removed).toBe(false);
    expect(probed.absent).toBe("missing");
    expect(probed.error).toMatch(/not a working tree/);

    const receipt = await removeAgentWorktree(cardPorts(h), AGENT, true);

    expect(receipt.removed).toBe(true);
    expect(receipt.checkoutAlreadyAbsent).toBe(true);
    expect(receipt.absence).toBe("missing");
    expect(receipt.branchDeleted).toBe(false); // nothing proved what that branch still holds
    expect(h.ledger.get(AGENT)?.worktree).toBeUndefined();
    expect(h.managed.list({ kind: "agent" })).toHaveLength(0);
  });

  it("a directory git disclaims is absent as a worktree, and is not deleted behind git's back", async () => {
    const h = harness();
    const rec = giveAgentAWorktree(h);
    git(["worktree", "remove", rec.path], h.repo);
    fs.mkdirSync(rec.path, { recursive: true });
    fs.writeFileSync(path.join(rec.path, "leftover.txt"), "not git's\n");

    const receipt = await removeAgentWorktree(cardPorts(h), AGENT, true);

    expect(receipt.checkoutAlreadyAbsent).toBe(true);
    expect(receipt.absence).toBe("not-a-worktree");
    expect(h.ledger.get(AGENT)?.worktree).toBeUndefined();
    // We released a claim; we did not delete a directory git says is none of our business.
    expect(fs.existsSync(path.join(rec.path, "leftover.txt"))).toBe(true);
  });

  it("a removal that fails for a real git reason still fails, and both records keep their claim", async () => {
    const h = harness();
    const rec = giveAgentAWorktree(h);
    const entry = h.managed.list({ kind: "agent" })[0]!;
    // A locked worktree: git refuses even `--force`, and the checkout is still very much there.
    git(["worktree", "lock", rec.path], h.repo);

    await expect(removeAgentWorktree(cardPorts(h), AGENT, true)).rejects.toThrow(/locked/i);

    expect(fs.existsSync(rec.path)).toBe(true);
    expect(h.ledger.get(AGENT)?.worktree?.path).toBe(rec.path);
    expect(h.managed.get(entry.id)).toBeDefined();
  });
});
