import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { delegationRecordFromSpawn, writeDelegationRecord } from "../../src/bridge/delegationRecord.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { GitExec } from "../../src/worktree/WorktreeManager.js";

function fakeTmux() {
  const sessions = new Set<string>();
  const dead = new Map<string, number>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "kill-session":
        sessions.delete(target());
        dead.delete(target());
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: `${[...sessions].join("\n")}\n`, stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: `${[...sessions].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t${dead.get(s) ?? ""}`).join("\n")}\n`, stderr: "" };
      case "display-message":
        return { stdout: "", stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, dead, tmux: new TmuxService(exec) };
}

function fakeGitExec(head = "head-after-review"): GitExec {
  return async (args) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${head}\n`, stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
}

describe("container-generated delegation behavior", () => {
  it("live agent state survives an extension-host reload rehydration without orphaned or lost signals", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cxreloadcore-"));
    try {
      const ws = path.join(base, "ws");
      const worktreePath = path.join(base, "worktrees", "owner");
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.mkdirSync(ws, { recursive: true });

      const { dead, tmux } = fakeTmux();
      const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n");
      const ledger = new SessionLedger(ws);
      const wsHash = workspaceHash(ws);
      const ownerRecord = delegationRecordFromSpawn({
        agent: "owner",
        baseSha: "base-owner",
        taskRef: "tachyon/owner",
        gate: { behaviorTest: "live agent state survives an extension-host reload rehydration without orphaned or lost signals", owns: ["src/agents"] },
        contract: { task: "fix reload restore", context: "ctx", constraints: "stay scoped", doneWhen: "verify passes" },
        createdAt: "2026-07-08T20:00:00.000Z",
        worktreePath,
      });
      writeDelegationRecord(ws, ownerRecord);
      ledger.record("owner", {
        worktree: { path: worktreePath, branch: "tachyon/owner", tachyonCreatedBranch: true, baseRef: "base-owner", createdAt: "2026-07-08T20:00:00.000Z" },
        cwd: worktreePath,
        declared: false,
      });

      const beforeReload = new AgentManager({
        tmux,
        wsHash,
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        gitExec: fakeGitExec(),
      });
      await beforeReload.spawn("fixer-1", {
        cmd: "claude",
        parent: "boss",
        reuseWorktree: { delegationId: ownerRecord.id, ownsSubset: ["src/agents"] },
      });
      dead.set(beforeReload.session("fixer-1"), 1);

      const afterReload = new AgentManager({
        tmux,
        wsHash,
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        gitExec: fakeGitExec(),
      });
      afterReload.rehydrateFromLedger();

      await expect(
        afterReload.spawn("fixer-2", {
          cmd: "claude",
          parent: "boss",
          reuseWorktree: { delegationId: ownerRecord.id, ownsSubset: ["src/agents"] },
        }),
      ).rejects.toThrow(/WORKTREE_DIRTY_OR_UNVERIFIED/);
      expect((await afterReload.list()).find((entry) => entry.name === "fixer-1")?.dead).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
