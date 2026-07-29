import { describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";

describe("container-generated delegation behavior", () => {
  it("graceful stop uses each runtime's measured exit sequence", async () => {
    async function keysFor(cmd: string): Promise<string[]> {
      const wsHash = workspaceHash("/workspace");
      const session = `tachyon-${wsHash}-agent`;
      const sessions = new Set<string>([session]);
      const sentKeys: string[] = [];
      const panes = new Map<string, string>([[session, "• Working (1m 02s • esc to interrupt)"]]);

      const exec = async (args: string[]): Promise<ExecResult> => {
        const cmdName = args[2];
        const targetSession = (): string => {
          const target = args[args.indexOf("-t") + 1] ?? "";
          return target.replace(/^=/, "").replace(/:$/, "");
        };

        switch (cmdName) {
          case "has-session":
            if (!sessions.has(targetSession())) throw new Error("missing");
            return { stdout: "", stderr: "" };
          case "list-panes":
            return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
          case "capture-pane":
            return { stdout: panes.get(targetSession()) ?? "", stderr: "" };
          case "send-keys":
            sentKeys.push(args.at(-1) ?? "");
            return { stdout: "", stderr: "" };
          default:
            return { stdout: "", stderr: "" };
        }
      };

      const manager = new AgentManager({
        tmux: new TmuxService(exec),
        wsHash,
        workspaceRoot: "/workspace",
        getConfig: () => configOf(`agents:\n  agent:\n    cmd: ${cmd}\n`),
        getMaxAgents: () => 8,
      });

      await manager.stopGracefully("agent");
      return sentKeys;
    }

    await expect(keysFor("claude")).resolves.toEqual(["Escape", "C-c", "/exit", "C-m"]);
    await expect(keysFor("codex")).resolves.toEqual(["Escape", "C-c", "C-d", "C-d"]);
    // t-b103c5: cancel-then-exit — third if-alive C-c when tool-auth remaps Ctrl+C to cancel
    await expect(keysFor("grok")).resolves.toEqual(["C-c", "C-c", "C-c"]);
    await expect(keysFor("opencode")).resolves.toEqual(["C-d"]);
    await expect(keysFor("custom-ai")).resolves.toEqual(["C-c", "C-c", "C-d"]);
  });
});

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}
