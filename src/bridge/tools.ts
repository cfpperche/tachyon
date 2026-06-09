import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentManager } from "../agents/AgentManager.js";
import type { TmuxService } from "../tmux/TmuxService.js";

export type NotifyLevel = "info" | "warn" | "error";

export interface BridgeDeps {
  manager: AgentManager;
  tmux: TmuxService;
  /** Surfaces a message to the human — wired to vscode.window.show*Message in the extension. */
  notify: (message: string, level: NotifyLevel) => void;
}

const AGENT_NAME = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "agent name must start with a letter and use [a-zA-Z0-9_-]");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

/** The 7 v1 Bridge tools. Thin, schema-validated delegation — no business logic here. */
export function registerTools(mcp: McpServer, deps: BridgeDeps): void {
  mcp.registerTool(
    "spawn_agent",
    {
      description:
        "Start an agent in this workspace. With only a name, spawns the agent declared in tachyon.yml; " +
        "pass cmd to spawn an ad-hoc sub-agent (e.g. a fresh AI CLI for a delegated task). " +
        "Subject to the maxAgents guardrail.",
      inputSchema: {
        name: AGENT_NAME.describe("agent name (becomes part of the tmux session name)"),
        cmd: z.string().min(1).optional().describe("shell command for an ad-hoc agent; omit to use tachyon.yml"),
        cwd: z.string().optional().describe("working directory for an ad-hoc agent"),
      },
    },
    async ({ name, cmd, cwd }) => {
      try {
        await deps.manager.spawn(name, cmd ? { cmd, cwd } : undefined);
        return ok(`agent '${name}' spawned (session ${deps.manager.session(name)})`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "kill_agent",
    {
      description: "Stop a running agent (kills its tmux session).",
      inputSchema: { name: AGENT_NAME },
    },
    async ({ name }) => {
      try {
        await deps.manager.kill(name);
        return ok(`agent '${name}' killed`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "restart_agent",
    {
      description: "Restart an agent (kill + spawn with the same definition).",
      inputSchema: { name: AGENT_NAME },
    },
    async ({ name }) => {
      try {
        await deps.manager.restart(name);
        return ok(`agent '${name}' restarted`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_agents",
    {
      description: "List this workspace's agents: declared in tachyon.yml and/or currently running.",
      inputSchema: {},
    },
    async () => {
      try {
        const agents = await deps.manager.list();
        return ok(JSON.stringify(agents, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "read_output",
    {
      description:
        "Read another agent's terminal output. Returns the visible pane by default " +
        "(what a human looking at the agent's terminal sees); pass lines to reach into scrollback.",
      inputSchema: {
        name: AGENT_NAME,
        lines: z.number().int().min(1).max(10000).optional().describe("how many lines of scrollback to include"),
      },
    },
    async ({ name, lines }) => {
      try {
        const session = deps.manager.session(name);
        if (!(await deps.tmux.hasSession(session))) {
          return fail(new Error(`agent '${name}' is not running`));
        }
        return ok(await deps.tmux.capturePane(session, lines));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "write_input",
    {
      description:
        "Type into another agent's terminal. Text is sent literally; submit=true (default) presses Enter after it.",
      inputSchema: {
        name: AGENT_NAME,
        text: z.string().describe("text to type into the agent's terminal"),
        submit: z.boolean().default(true).describe("press Enter after the text"),
      },
    },
    async ({ name, text, submit }) => {
      try {
        const session = deps.manager.session(name);
        if (!(await deps.tmux.hasSession(session))) {
          return fail(new Error(`agent '${name}' is not running`));
        }
        await deps.tmux.sendKeys(session, text, submit);
        return ok(`input sent to '${name}'`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "notify",
    {
      description: "Show a notification to the human in VSCode (use sparingly — when you need them).",
      inputSchema: {
        message: z.string().min(1),
        level: z.enum(["info", "warn", "error"]).default("info"),
      },
    },
    async ({ message, level }) => {
      try {
        deps.notify(message, level);
        return ok("notification shown");
      } catch (err) {
        return fail(err);
      }
    },
  );
}
