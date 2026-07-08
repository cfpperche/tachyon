import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { delegationRecordFromSpawn, writeDelegationRecord, readDelegationRecord, type DelegationRecord } from "../../src/bridge/delegationRecord.js";
import type { GitExec } from "../../src/worktree/WorktreeManager.js";

/** Stateful in-memory tmux fake (same shape as agentManager.test.ts's fakeTmux): tracks live sessions
 *  and remain-on-exit "dead" panes (a crashed occupant whose session lingers as a postmortem, distinct
 *  from a fully-killed/gone session) so a reuse grant's occupancy refresh has something real to probe. */
function fakeTmux() {
  const sessions = new Set<string>();
  const dead = new Map<string, number>();
  /** t-815796 MEDIUM fix — the occupant's pane-root pid, keyed by session name; `panePid`'s
   *  `display-message #{pane_pid}` reads from here so a test can pre-arm what AgentManager captures
   *  right after a reuse grant lands, and later simulate that pid outliving (or not) its tmux session. */
  const pids = new Map<string, number>();
  const newSessionArgs: string[][] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => {
      const i = args.indexOf("-t");
      return args[i + 1].replace(/^=/, "").replace(/:$/, "");
    };
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      newSessionArgs.push(args);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        dead.delete(target());
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: [...sessions].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t${dead.get(s) ?? ""}`).join("\n") + "\n", stderr: "" };
      case "display-message": {
        const pid = pids.get(target());
        return { stdout: pid !== undefined ? `${pid}\n` : "", stderr: "" };
      }
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, dead, pids, newSessionArgs, tmux: new TmuxService(exec) };
}

/** A pid that is confirmed NOT alive: spawn a trivial child and let `spawnSync` block until it exits
 *  AND is reaped, so by the time this returns the pid is free again (barring an astronomically unlikely
 *  concurrent reuse of the same pid number). Used to exercise the "pid confirmed gone" free path without
 *  any fake/mocked process table. */
function aKnownDeadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (typeof result.pid !== "number") throw new Error("could not obtain a pid to use as a known-dead pid");
  return result.pid;
}

/** Fake git executor: HEAD is whatever was last stamped for that worktree path, defaulting to "sha0". */
function fakeGitExec(headByPath: Map<string, string>): GitExec {
  return async (args, cwd) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stdout: `${headByPath.get(cwd) ?? "sha0"}\n`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

describe("container-generated delegation behavior", () => {
  it("reuse_worktree grants an existing delegation's worktree atomically with occupancy, subset authority and head pinning", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-snreuse-"));
    try {
      const ws = path.join(base, "ws");
      fs.mkdirSync(ws, { recursive: true });
      const { sessions, dead, newSessionArgs, tmux } = fakeTmux();
      const headByPath = new Map<string, string>();
      const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n");
      const ledger = new SessionLedger(ws);
      const manager = new AgentManager({
        tmux,
        wsHash: workspaceHash(ws),
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        gitExec: fakeGitExec(headByPath),
      });

      /** Registers a fresh delegation (an original gated agent's finished worktree, never itself
       *  spawned in this test — the "owner" is not live, so its worktree starts out free) and returns
       *  its record + on-disk path. */
      function seedDelegation(agent: string, owns: string[], createdAt: string): { record: DelegationRecord; recordPath: string; worktreePath: string } {
        const worktreePath = path.join(base, "worktrees", agent);
        fs.mkdirSync(worktreePath, { recursive: true });
        headByPath.set(worktreePath, "head-initial");
        const record = delegationRecordFromSpawn({
          agent,
          baseSha: `base-${agent}`,
          taskRef: `tachyon/${agent}`,
          gate: { behaviorTest: "some behavior test", owns },
          contract: { task: "fix the thing", context: "the original delegation was completed", constraints: "no scope creep", doneWhen: "tests pass" },
          createdAt,
        });
        const recordPath = writeDelegationRecord(ws, record);
        ledger.record(agent, {
          worktree: { path: worktreePath, branch: `tachyon/${agent}`, tachyonCreatedBranch: true, baseRef: `base-${agent}`, createdAt },
          cwd: worktreePath,
          declared: false,
        });
        return { record, recordPath, worktreePath };
      }

      // ── (a) a reuse spawn against a FREE worktree lands with cwd=worktree and isolatedWorktree semantics ──
      const free = seedDelegation("owner-free", ["src/free.ts"], "2026-07-08T00:00:00.000Z");
      await manager.spawn("fixer-free", {
        cmd: "claude",
        parent: "boss",
        reuseWorktree: { delegationId: free.record.id, ownsSubset: ["src/free.ts"] },
      });
      expect(sessions.has(manager.session("fixer-free"))).toBe(true);
      const fixerFreeArgs = newSessionArgs.find((a) => a[a.indexOf("-s") + 1] === manager.session("fixer-free"))!;
      expect(fixerFreeArgs[fixerFreeArgs.indexOf("-c") + 1]).toBe(free.worktreePath); // cwd = the reused worktree
      expect(ledger.get("fixer-free")?.worktree?.path).toBe(free.worktreePath); // isolatedWorktree semantics persisted
      const grantedRecord = readDelegationRecord(free.recordPath);
      expect(grantedRecord.fixerAttempts).toEqual([
        { occupantAgent: "fixer-free", requestedOwnsSubset: ["src/free.ts"], grantedAt: expect.any(String), branchHeadAtGrant: "head-initial" },
      ]);

      // ── (b) a second CONCURRENT reuse against the SAME worktree is refused WORKTREE_OCCUPIED ──
      const raced = seedDelegation("owner-race", ["src/race.ts"], "2026-07-08T00:01:00.000Z");
      const [first, second] = await Promise.allSettled([
        manager.spawn("fixer-race-a", { cmd: "claude", parent: "boss", reuseWorktree: { delegationId: raced.record.id, ownsSubset: ["src/race.ts"] } }),
        manager.spawn("fixer-race-b", { cmd: "claude", parent: "boss", reuseWorktree: { delegationId: raced.record.id, ownsSubset: ["src/race.ts"] } }),
      ]);
      const outcomes = [first, second];
      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(fulfilled).toHaveLength(1); // the mutex serializes the pair — exactly one grant lands
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/WORKTREE_OCCUPIED/);

      // ── (c) owns_subset ⊄ original owns is refused REUSE_OWNS_WIDENING ──
      const widened = seedDelegation("owner-widen", ["src/allowed.ts"], "2026-07-08T00:02:00.000Z");
      await expect(
        manager.spawn("fixer-widen", { cmd: "claude", parent: "boss", reuseWorktree: { delegationId: widened.record.id, ownsSubset: ["src/not-allowed.ts"] } }),
      ).rejects.toThrow(/REUSE_OWNS_WIDENING/);
      expect(sessions.has(manager.session("fixer-widen"))).toBe(false);

      // ── (c2) a `..`-escaping owns_subset entry ("src/agents/../bridge") must NOT pass as a subset of
      // "src/agents" just because it string-prefix-matches before resolution — it actually resolves to
      // the sibling "src/bridge", outside the original owns entirely, and must be refused. ──
      const traversal = seedDelegation("owner-traversal", ["src/agents"], "2026-07-08T00:02:30.000Z");
      await expect(
        manager.spawn("fixer-traversal", {
          cmd: "claude",
          parent: "boss",
          reuseWorktree: { delegationId: traversal.record.id, ownsSubset: ["src/agents/../bridge"] },
        }),
      ).rejects.toThrow(/REUSE_OWNS_WIDENING/);
      expect(sessions.has(manager.session("fixer-traversal"))).toBe(false);

      // ── (d) expected_head mismatch is refused BRANCH_HEAD_CHANGED ──
      const headPinned = seedDelegation("owner-head", ["src/head.ts"], "2026-07-08T00:03:00.000Z");
      await expect(
        manager.spawn("fixer-head", {
          cmd: "claude",
          parent: "boss",
          reuseWorktree: { delegationId: headPinned.record.id, ownsSubset: ["src/head.ts"], expectedHead: "a-stale-sha-from-an-earlier-review" },
        }),
      ).rejects.toThrow(/BRANCH_HEAD_CHANGED/);
      expect(sessions.has(manager.session("fixer-head"))).toBe(false);

      // ── (e) a dead-but-unprobed occupant leaves the worktree dirty and reuse is refused ──
      const quarantined = seedDelegation("owner-dirty", ["src/dirty.ts"], "2026-07-08T00:04:00.000Z");
      await manager.spawn("fixer-dirty-1", {
        cmd: "claude",
        parent: "boss",
        reuseWorktree: { delegationId: quarantined.record.id, ownsSubset: ["src/dirty.ts"] },
      });
      // The occupant crashes: its tmux session lingers as a remain-on-exit dead pane (NOT fully gone) —
      // an inconclusive cleanup probe (design point 3), so death does not free the worktree.
      dead.set(manager.session("fixer-dirty-1"), 1);
      await expect(
        manager.spawn("fixer-dirty-2", { cmd: "claude", parent: "boss", reuseWorktree: { delegationId: quarantined.record.id, ownsSubset: ["src/dirty.ts"] } }),
      ).rejects.toThrow(/WORKTREE_DIRTY_OR_UNVERIFIED/);
      expect(sessions.has(manager.session("fixer-dirty-2"))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("t-815796 design point 1: an ambiguous agent-name reuse target is refused AMBIGUOUS_REUSE_TARGET, naming every match", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-snreuse-ambig-"));
    try {
      const ws = path.join(base, "ws");
      fs.mkdirSync(ws, { recursive: true });
      const { tmux } = fakeTmux();
      const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n");
      const ledger = new SessionLedger(ws);
      const manager = new AgentManager({
        tmux,
        wsHash: workspaceHash(ws),
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        gitExec: fakeGitExec(new Map()),
      });

      // Two non-archived delegations for the SAME agent NAME (e.g. the name was reused across two
      // separate delegated rounds) — agent-name sugar must refuse ambiguously rather than guess.
      for (const createdAt of ["2026-07-08T00:00:00.000Z", "2026-07-08T00:05:00.000Z"]) {
        const worktreePath = path.join(base, "worktrees", `dup-${createdAt}`);
        fs.mkdirSync(worktreePath, { recursive: true });
        const record = delegationRecordFromSpawn({
          agent: "dup",
          baseSha: "base",
          taskRef: "tachyon/dup",
          gate: { behaviorTest: "some behavior test", owns: ["src/dup.ts"] },
          contract: { task: "fix the thing", context: "the original delegation was completed", constraints: "no scope creep", doneWhen: "tests pass" },
          createdAt,
        });
        writeDelegationRecord(ws, record);
        ledger.record("dup", { worktree: { path: worktreePath, branch: "tachyon/dup", tachyonCreatedBranch: true, baseRef: "base", createdAt }, cwd: worktreePath, declared: false });
      }

      await expect(
        manager.spawn("fixer-dup", { cmd: "claude", parent: "boss", reuseWorktree: { agentName: "dup", ownsSubset: ["src/dup.ts"] } }),
      ).rejects.toThrow(/AMBIGUOUS_REUSE_TARGET/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("t-815796 MEDIUM fix: a captured pid still alive keeps a session-gone worktree quarantined dirty", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-snreuse-pid-alive-"));
    try {
      const ws = path.join(base, "ws");
      fs.mkdirSync(ws, { recursive: true });
      const { sessions, pids, tmux } = fakeTmux();
      const headByPath = new Map<string, string>();
      const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n");
      const ledger = new SessionLedger(ws);
      const manager = new AgentManager({
        tmux,
        wsHash: workspaceHash(ws),
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        gitExec: fakeGitExec(headByPath),
      });

      const worktreePath = path.join(base, "worktrees", "owner-pid-alive");
      fs.mkdirSync(worktreePath, { recursive: true });
      headByPath.set(worktreePath, "head-initial");
      const record = delegationRecordFromSpawn({
        agent: "owner-pid-alive",
        baseSha: "base-owner-pid-alive",
        taskRef: "tachyon/owner-pid-alive",
        gate: { behaviorTest: "some behavior test", owns: ["src/alive.ts"] },
        contract: { task: "fix the thing", context: "ctx", constraints: "none", doneWhen: "tests pass" },
        createdAt: "2026-07-08T02:00:00.000Z",
      });
      writeDelegationRecord(ws, record);
      ledger.record("owner-pid-alive", {
        worktree: { path: worktreePath, branch: "tachyon/owner-pid-alive", tachyonCreatedBranch: true, baseRef: "base-owner-pid-alive", createdAt: "2026-07-08T02:00:00.000Z" },
        cwd: worktreePath,
        declared: false,
      });

      // Pre-arm the fake's pane_pid for the SESSION AgentManager is about to spawn — this test process's
      // own pid, guaranteed alive — so the grant captures it exactly as production code does.
      pids.set(manager.session("fixer-pid-alive"), process.pid);
      await manager.spawn("fixer-pid-alive", {
        cmd: "claude",
        parent: "boss",
        reuseWorktree: { delegationId: record.id, ownsSubset: ["src/alive.ts"] },
      });

      // The occupant's tmux session disappears ENTIRELY (not a lingering dead pane — actually gone),
      // simulating a tmux-server-level bookkeeping loss or a reparented pane, while its root process
      // (this test's own pid) is still very much alive.
      sessions.delete(manager.session("fixer-pid-alive"));

      await expect(
        manager.spawn("fixer-pid-alive-2", {
          cmd: "claude",
          parent: "boss",
          reuseWorktree: { delegationId: record.id, ownsSubset: ["src/alive.ts"] },
        }),
      ).rejects.toThrow(/WORKTREE_DIRTY_OR_UNVERIFIED/);
      expect(sessions.has(manager.session("fixer-pid-alive-2"))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("t-815796 MEDIUM fix: a captured pid confirmed gone (ESRCH) frees the worktree even though the free happens on tmux-session-gone", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-snreuse-pid-dead-"));
    try {
      const ws = path.join(base, "ws");
      fs.mkdirSync(ws, { recursive: true });
      const { sessions, pids, tmux } = fakeTmux();
      const headByPath = new Map<string, string>();
      const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n");
      const ledger = new SessionLedger(ws);
      const manager = new AgentManager({
        tmux,
        wsHash: workspaceHash(ws),
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        gitExec: fakeGitExec(headByPath),
      });

      const worktreePath = path.join(base, "worktrees", "owner-pid-dead");
      fs.mkdirSync(worktreePath, { recursive: true });
      headByPath.set(worktreePath, "head-initial");
      const record = delegationRecordFromSpawn({
        agent: "owner-pid-dead",
        baseSha: "base-owner-pid-dead",
        taskRef: "tachyon/owner-pid-dead",
        gate: { behaviorTest: "some behavior test", owns: ["src/dead.ts"] },
        contract: { task: "fix the thing", context: "ctx", constraints: "none", doneWhen: "tests pass" },
        createdAt: "2026-07-08T03:00:00.000Z",
      });
      writeDelegationRecord(ws, record);
      ledger.record("owner-pid-dead", {
        worktree: { path: worktreePath, branch: "tachyon/owner-pid-dead", tachyonCreatedBranch: true, baseRef: "base-owner-pid-dead", createdAt: "2026-07-08T03:00:00.000Z" },
        cwd: worktreePath,
        declared: false,
      });

      pids.set(manager.session("fixer-pid-dead"), aKnownDeadPid());
      await manager.spawn("fixer-pid-dead", {
        cmd: "claude",
        parent: "boss",
        reuseWorktree: { delegationId: record.id, ownsSubset: ["src/dead.ts"] },
      });

      // Session fully gone AND the captured root pid is confirmed gone too (ESRCH) — the honest reading
      // of design point 3's "tmux gone + no root process" probe: this one frees.
      sessions.delete(manager.session("fixer-pid-dead"));

      await manager.spawn("fixer-pid-dead-2", {
        cmd: "claude",
        parent: "boss",
        reuseWorktree: { delegationId: record.id, ownsSubset: ["src/dead.ts"] },
      });
      expect(sessions.has(manager.session("fixer-pid-dead-2"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
