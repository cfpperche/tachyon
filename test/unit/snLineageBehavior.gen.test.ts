import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { writeDelegationRecord, delegationRecordFromSpawn, readLatestDelegationRecord } from "../../src/bridge/delegationRecord.js";

/** Minimal tmux exec stub: tracks live session names, no real process behind them. */
function makeExec(): (args: string[]) => Promise<ExecResult> {
  const sessions = new Set<string>();
  return async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("none");
        return { stdout: "", stderr: "" };
      case "kill-session":
        sessions.delete(target());
        return { stdout: "", stderr: "" };
      case "list-panes":
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
      case "list-sessions":
        if (!sessions.size) throw new Error("no server");
        return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
}

describe("container-generated delegation behavior", () => {
  it("a gated agent's delegator lineage survives an extension reload", async () => {
    // t-bae303 — maintainer repro: a gated spawn (delegator=claude) nested correctly in the sidebar,
    // but reappeared TOP-LEVEL after a reload. Cause: rehydrateFromLedger only rebuilt lineage from
    // `record.def.parent`; a gated spawn forces `parent:undefined` and lives only in the in-memory
    // `delegators` Map, which dies on reload. Fixed by persisting `delegator` on the ledger record at
    // spawn time (SessionLedger.SessionDef.delegator) and restoring it in rehydrateFromLedger.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-snlineage-"));
    try {
      const ws = path.join(base, "ws");
      const worktreePath = path.join(base, "worktrees", "reviewer");
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(worktreePath, { recursive: true });

      const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n");
      const wsHash = workspaceHash(ws);
      const ledger = new SessionLedger(ws);
      // Production Workspace authenticates this read before returning it. This focused AgentManager
      // fixture supplies the same host-trusted boundary while retaining a pre-hardening record shape.
      const readAuthenticatedLegacyDelegation = async (agent: string) => readLatestDelegationRecord(ws, agent);

      const spawnManager = new AgentManager({
        tmux: new TmuxService(makeExec()),
        wsHash,
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        resolveSpawnCwd: async () => ({
          cwd: worktreePath,
          worktree: { path: worktreePath, branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "base-sha", createdAt: "t" },
        }),
        recordDelegation: ({ name, delegator, gate, contract, worktree, baseSha }) => {
          writeDelegationRecord(
            ws,
            delegationRecordFromSpawn({ agent: name, delegator, baseSha, taskRef: worktree.branch, gate, contract, createdAt: "2026-07-08T16:03:13.220Z" }),
          );
        },
      });

      await spawnManager.spawn("reviewer", {
        cmd: "claude",
        parent: "boss",
        delegator: "boss",
        contract: { task: "fix the bug", context: "ctx", constraints: "no new deps", doneWhen: "test passes" },
        gate: { behaviorTest: "some behavior test" },
      });

      // Pre-reload: nested under its delegator, not top-level (gated spawns never get a runtime parent).
      const preReload = (await spawnManager.list()).find((a) => a.name === "reviewer");
      expect(preReload?.parent).toBeUndefined();
      expect(preReload?.delegator).toBe("boss");
      expect(ledger.get("reviewer")?.def?.delegator).toBe("boss"); // now persisted, not just in-memory

      // Simulate an extension reload: a FRESH AgentManager over the same on-disk ledger. The prior
      // instance's in-memory `delegators` Map is gone — only rehydrateFromLedger can restore lineage.
      const reloadedManager = new AgentManager({
        tmux: new TmuxService(makeExec()),
        wsHash,
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        readAuthenticatedLegacyDelegation,
      });
      await reloadedManager.rehydrateFromLedger();

      const reloaded = (await reloadedManager.list()).find((a) => a.name === "reviewer");
      expect(reloaded?.parent).toBeUndefined();
      expect(reloaded?.delegator).toBe("boss"); // sidebar view model reads list()'s `delegator` — nests it back under 'boss'
      expect(reloadedManager.delegatorOf("reviewer")).toBe("boss"); // re-anchor/resume's primer source, same fix

      // A pre-fix-shaped ledger record (written before this fix existed — no `delegator` field on
      // `def`) must ALSO rehydrate via the DelegationRecord fallback (mirrors the t-fb19bd restart
      // fallback pattern), covering every row already on disk in the live fleet.
      const legacyWorktreePath = path.join(base, "worktrees", "legacy");
      fs.mkdirSync(legacyWorktreePath, { recursive: true });
      writeDelegationRecord(ws, {
        agent: "legacy",
        delegator: "boss",
        baseSha: "sha1",
        taskRef: "tachyon/legacy",
        owns: [],
        behaviorTest: "some behavior test",
        contract: { task: "fix the other bug" },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      ledger.record("legacy", {
        def: { cmd: "claude", kind: "agent" }, // pre-fix shape — no `delegator` field, matching a live cxActLow-style row
        worktree: { path: legacyWorktreePath, branch: "tachyon/legacy", tachyonCreatedBranch: true, baseRef: "sha1", createdAt: "t" },
        cwd: legacyWorktreePath,
        declared: false,
      });

      const fallbackManager = new AgentManager({
        tmux: new TmuxService(makeExec()),
        wsHash,
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        readAuthenticatedLegacyDelegation,
      });
      await fallbackManager.rehydrateFromLedger();

      const legacy = (await fallbackManager.list()).find((a) => a.name === "legacy");
      expect(legacy?.delegator).toBe("boss");
      expect(fallbackManager.delegatorOf("legacy")).toBe("boss");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
