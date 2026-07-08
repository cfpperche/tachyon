import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { HarnessManager } from "../../src/harness/HarnessManager.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { delegatedOpencodePermission, expectedAgentOpencodeEntry } from "../../src/registration/adapters.js";

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
      const exec = async (args: string[]): Promise<ExecResult> => {
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
});
