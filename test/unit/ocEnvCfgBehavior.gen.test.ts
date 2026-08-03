import { skipTestsWithoutOptionalRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { HarnessManager } from "../../src/harness/HarnessManager.js";
import { expectedAgentOpencodeEntry } from "../../src/registration/adapters.js";

/** spec 236 — behavior: a Tachyon-spawned opencode agent reaches the Bridge MCP with ZERO
 *  workspace-file config of its own. opencode honors the OPENCODE_CONFIG env var (verified 1.17.15)
 *  and resolves `{env:VAR}` placeholders at runtime, so Tachyon:
 *    - minta a per-agent token into the spawn env (TACHYON_AGENT_BRIDGE_TOKEN, spec 351),
 *    - materializes a Bridge-only opencode config file pointing at the Bridge URL with the bearer
 *      header `Authorization: Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}` (token stays a ref → no
 *      secret on disk or argv),
 *    - injects the file's path into the spawn env as OPENCODE_CONFIG.
 *  This behavior test mirrors `src/agents/AgentManager.ts` spec-236 path: the materializer is
 *  `materializeBridgeMcpOpencode(name, cwd)` and is folded into spawnBuild.env as OPENCODE_CONFIG.
 */
skipTestsWithoutOptionalRuntimeAuth({
  opencode: [
    "opencode spawns receive bridge mcp config via environment",
  ],
});

describe("container-generated delegation behavior", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Capture every new-session invocation's argv (env -e pairs and the spawned cmd ride inside). */
  function fakeCapture() {
    const newSessionArgs: string[][] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) {
        newSessionArgs.push(args);
        return { stdout: "", stderr: "" };
      }
      switch (args[2]) {
        case "has-session":
          throw new Error("can't find session");
        case "list-sessions":
          throw new Error("no server running");
        case "list-panes":
          if (newSessionArgs.length === 0) throw new Error("no server running");
          return { stdout: newSessionArgs.map((a) => `${a[a.indexOf("-s") + 1]}\t0\t`).join("\n") + "\n", stderr: "" };
        default:
          return { stdout: "", stderr: "" };
      }
    };
    return { newSessionArgs, tmux: new TmuxService(exec) };
  }

  function envOf(args: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-e" && i + 1 < args.length) {
        const pair = args[i + 1];
        const eq = pair.indexOf("=");
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
    return env;
  }

  it("opencode spawns receive bridge mcp config via environment", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ocenvcfg-"));
    dirs.push(ws);
    const harness = new HarnessManager(ws, ws);
    const BRIDGE_URL = "http://127.0.0.1:9/mcp";
    const entry = expectedAgentOpencodeEntry(BRIDGE_URL, /* auth */ true);

    const { newSessionArgs, tmux } = fakeCapture();
    const { config } = parseConfig("agents:\n  oc:\n    cmd: opencode\n");
    const manager = new AgentManager({
      tmux,
      wsHash: workspaceHash(ws),
      workspaceRoot: ws,
      getConfig: () => config,
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: BRIDGE_URL, TACHYON_BRIDGE_TOKEN: "tok" }),
      mintAgentToken: (name) => ({ TACHYON_AGENT_BRIDGE_TOKEN: `agent-token-${name}` }),
      materializeBridgeMcpOpencode: (name, cwd) => {
        // Real materialization: write the Bridge-only file into the workspace's
        // .tachyon/bridge-mcp/ dir so we can read it back and assert the on-disk content.
        const projectOpencodeJson = (() => {
          try {
            return fs.readFileSync(path.join(cwd, "opencode.json"), "utf8");
          } catch {
            return undefined;
          }
        })();
        return harness.materializeBridgeMcpOpencode(name, entry, projectOpencodeJson);
      },
    });

    await manager.spawn("oc", { cmd: "opencode" });

    expect(newSessionArgs).toHaveLength(1);
    const args = newSessionArgs[0];
    const env = envOf(args);

    // 1. OPENCODE_CONFIG env var is present and points at a file.
    expect(Object.keys(env)).toContain("OPENCODE_CONFIG");
    expect(typeof env.OPENCODE_CONFIG).toBe("string");
    expect(env.OPENCODE_CONFIG.length).toBeGreaterThan(0);

    // 2. The per-agent token also lands in the spawn env (the {env:} ref resolves from it at runtime).
    expect(env.TACHYON_AGENT_BRIDGE_TOKEN).toBe("agent-token-oc");

    // 3. The file at the OPENCODE_CONFIG path exists and carries the Bridge entry under mcp.tachyon_bridge
    //    with the per-agent-token ref and the exact Bridge URL (no literal token on disk).
    expect(fs.existsSync(env.OPENCODE_CONFIG)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, "utf8")) as {
      $schema?: string;
      mcp?: Record<string, { type?: string; url?: string; enabled?: boolean; headers?: { Authorization?: string } }>;
    };
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    const bridge = parsed.mcp?.tachyon_bridge;
    expect(bridge).toBeDefined();
    expect(bridge!.type).toBe("remote");
    expect(bridge!.url).toBe(BRIDGE_URL);
    expect(bridge!.enabled).toBe(true);
    expect(bridge!.headers?.Authorization).toBe("Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}");
  });
});
