import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { HarnessManager } from "../../src/harness/HarnessManager.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { delegatedOpencodePermission, expectedAgentOpencodeEntry } from "../../src/registration/adapters.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";

/** Shared tmux exec stub: captures every `new-session` -e env pair, no server running otherwise. */
function makeExec(newSessionEnvs: Record<string, string>[]) {
  return async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      const env: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "-e" || i + 1 >= args.length) continue;
        const pair = args[i + 1];
        const eq = pair.indexOf("=");
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      newSessionEnvs.push(env);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") throw new Error("can't find session");
    if (args[2] === "list-sessions" || args[2] === "list-panes") throw new Error("no server running");
    return { stdout: "", stderr: "" };
  };
}

describe("container-generated delegation behavior", () => {
  it("a delegated opencode agent's generated config carries the Tachyon permission block and project config cannot override it", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cxperm-"));
    try {
      const ws = path.join(base, "ws");
      const worktreePath = path.join(base, "worktrees", "child");
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(worktreePath, { recursive: true });
      const projectOpencode = `${JSON.stringify({
        mcp: { projectTool: { type: "local", command: ["project-tool"] } },
        permission: {
          edit: "deny",
          bash: "deny",
          external_directory: { "*": "deny" },
          webfetch: "allow",
        },
        model: "project/model",
      }, null, 2)}\n`;
      fs.writeFileSync(path.join(ws, "opencode.json"), projectOpencode);
      fs.writeFileSync(path.join(worktreePath, "opencode.json"), projectOpencode);

      const newSessionEnvs: Record<string, string>[] = [];
      const exec = makeExec(newSessionEnvs);

      const bridgeUrl = "http://127.0.0.1:9/mcp";
      const harness = new HarnessManager(ws, ws, process.env, undefined);
      const { config } = parseConfig("agents:\n  parent:\n    cmd: claude\n");
      const manager = new AgentManager({
        tmux: new TmuxService(exec),
        wsHash: workspaceHash(ws),
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: bridgeUrl, TACHYON_BRIDGE_TOKEN: "shared" }),
        mintAgentToken: (name) => ({ TACHYON_AGENT_BRIDGE_TOKEN: `agent-token-${name}` }),
        resolveSpawnCwd: async () => ({
          cwd: worktreePath,
          worktree: { path: worktreePath, branch: "tachyon/child", tachyonCreatedBranch: true, baseRef: "base", createdAt: "now" },
        }),
        materializeBridgeMcpOpencode: (name, cwd) => {
          const projectOpencodeJson = fs.existsSync(path.join(cwd, "opencode.json")) ? fs.readFileSync(path.join(cwd, "opencode.json"), "utf8") : undefined;
          return harness.materializeBridgeMcpOpencode(name, expectedAgentOpencodeEntry(bridgeUrl, true), projectOpencodeJson);
        },
      });

      await manager.spawn("child", { cmd: "opencode", parent: "parent" });

      const generated = newSessionEnvs[0].OPENCODE_CONFIG;
      expect(generated).toBeTruthy();
      const parsed = JSON.parse(fs.readFileSync(generated, "utf8")) as {
        mcp: Record<string, unknown>;
        permission: Record<string, unknown>;
        model: string;
      };
      expect(Object.keys(parsed.mcp).sort()).toEqual(["projectTool", "tachyon_bridge"]);
      expect(parsed.model).toBe("project/model");
      expect(parsed.permission).toEqual(delegatedOpencodePermission(ws, path.dirname(worktreePath)));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("an ungated, shared-cwd delegated opencode agent (parent set, no worktree) does NOT get the Tachyon permission block", async () => {
    // Security review (782f1c6, HIGH): t-e2ebe3 made this population possible — a genuinely delegated
    // (`parent` truthy) opencode agent that inherits the parent's cwd instead of an isolated worktree.
    // The permission block's `bash:"allow"` is unconfined shell access with no `external_directory`
    // bound on it, so this population must fall back to opencode's own default, not get the block.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cxperm-"));
    try {
      const ws = path.join(base, "ws");
      fs.mkdirSync(ws, { recursive: true });
      const projectOpencode = `${JSON.stringify({
        mcp: { projectTool: { type: "local", command: ["project-tool"] } },
        model: "project/model",
      }, null, 2)}\n`;
      fs.writeFileSync(path.join(ws, "opencode.json"), projectOpencode);

      const newSessionEnvs: Record<string, string>[] = [];
      const exec = makeExec(newSessionEnvs);

      const bridgeUrl = "http://127.0.0.1:9/mcp";
      const harness = new HarnessManager(ws, ws, process.env, undefined);
      const { config } = parseConfig("agents:\n  parent:\n    cmd: claude\n");
      const manager = new AgentManager({
        tmux: new TmuxService(exec),
        wsHash: workspaceHash(ws),
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: bridgeUrl, TACHYON_BRIDGE_TOKEN: "shared" }),
        mintAgentToken: (name) => ({ TACHYON_AGENT_BRIDGE_TOKEN: `agent-token-${name}` }),
        // No resolveSpawnCwd → no worktree; the child inherits the parent's (shared) cwd, same as a
        // plain `spawn_agent(cmd:"opencode", parent:"boss")` with no `worktree:true`.
        materializeBridgeMcpOpencode: (name, cwd) => {
          const projectOpencodeJson = fs.existsSync(path.join(cwd, "opencode.json")) ? fs.readFileSync(path.join(cwd, "opencode.json"), "utf8") : undefined;
          return harness.materializeBridgeMcpOpencode(name, expectedAgentOpencodeEntry(bridgeUrl, true), projectOpencodeJson);
        },
      });

      await manager.spawn("child", { cmd: "opencode", parent: "parent" });

      const generated = newSessionEnvs[0].OPENCODE_CONFIG;
      expect(generated).toBeTruthy();
      const parsed = JSON.parse(fs.readFileSync(generated, "utf8")) as {
        mcp: Record<string, unknown>;
        permission?: Record<string, unknown>;
      };
      expect(Object.keys(parsed.mcp).sort()).toEqual(["projectTool", "tachyon_bridge"]);
      // No delegated permission block was stamped — the project file had none, and none was added.
      expect(parsed.permission).toBeUndefined();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("a gated opencode agent still gets the Tachyon permission block after ledger rehydration and resume", async () => {
    // Gated agents intentionally have no runtime parent. Canonical lineage is persisted on
    // SessionDef.delegator and rehydrated before resume after an engine/editor restart.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cxperm-"));
    try {
      const ws = path.join(base, "ws");
      const worktreePath = path.join(base, "worktrees", "child");
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(worktreePath, "opencode.json"), `${JSON.stringify({ mcp: {} }, null, 2)}\n`);

      const newSessionEnvs: Record<string, string>[] = [];
      const exec = makeExec(newSessionEnvs);

      const bridgeUrl = "http://127.0.0.1:9/mcp";
      const harness = new HarnessManager(ws, ws, process.env, undefined);
      const ledger = new SessionLedger(ws);
      const { config } = parseConfig("agents:\n  parent:\n    cmd: claude\n");
      const resumeRecord = {
        def: { cmd: "opencode", kind: "agent" as const, delegator: "boss" },
        resume: { runtime: "opencode" as const, sessionId: "ses_x" },
        worktree: { path: worktreePath, branch: "tachyon/child", tachyonCreatedBranch: true, baseRef: "base", createdAt: "now" },
        cwd: worktreePath,
        declared: false,
        updatedAt: "t",
      };
      ledger.record("child", resumeRecord);
      const manager = new AgentManager({
        tmux: new TmuxService(exec),
        wsHash: workspaceHash(ws),
        workspaceRoot: ws,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: bridgeUrl, TACHYON_BRIDGE_TOKEN: "shared" }),
        mintAgentToken: (name) => ({ TACHYON_AGENT_BRIDGE_TOKEN: `agent-token-${name}` }),
        materializeBridgeMcpOpencode: (name, cwd) => {
          const projectOpencodeJson = fs.existsSync(path.join(cwd, "opencode.json")) ? fs.readFileSync(path.join(cwd, "opencode.json"), "utf8") : undefined;
          return harness.materializeBridgeMcpOpencode(name, expectedAgentOpencodeEntry(bridgeUrl, true), projectOpencodeJson);
        },
      });

      await manager.rehydrateFromLedger();
      await manager.resume("child", resumeRecord);

      const generated = newSessionEnvs[0].OPENCODE_CONFIG;
      expect(generated).toBeTruthy();
      const parsed = JSON.parse(fs.readFileSync(generated, "utf8")) as { permission?: Record<string, unknown> };
      expect(parsed.permission).toEqual(delegatedOpencodePermission(ws, path.dirname(worktreePath)));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
