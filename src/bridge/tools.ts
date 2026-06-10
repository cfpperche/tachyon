import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentManager } from "../agents/AgentManager.js";
import type { TmuxService } from "../tmux/TmuxService.js";
import type { PinStore } from "../pins/PinStore.js";

export type NotifyLevel = "info" | "warn" | "error";

export interface BridgeDeps {
  manager: AgentManager;
  tmux: TmuxService;
  /** Shared human↔agent project memory (.tachyon/pins.json + notes.md). */
  pins: PinStore;
  /** Surfaces a message to the human — wired to vscode.window.show*Message in the extension. */
  notify: (message: string, level: NotifyLevel) => void;
  /** Attention state of an agent ("working" | "idle" | "needs-input"), when monitoring is active. */
  attentionOf?: (agent: string) => string | undefined;
  /** Fired after any pin/notes mutation — wired to the sidebar refresh. */
  onPinsChanged?: () => void;
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
        const enriched = agents.map((a) => ({
          ...a,
          ...(a.running && deps.attentionOf?.(a.name) ? { attention: deps.attentionOf(a.name) } : {}),
        }));
        return ok(JSON.stringify(enriched, null, 2));
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
    "create_pin",
    {
      description:
        "Pin a finding to the project's shared checklist (visible to the human in the sidebar and " +
        "to every agent via list_pins). Use for discoveries worth keeping: bugs found out of scope, " +
        "constraints learned the hard way, decisions other agents must know.",
      inputSchema: {
        text: z.string().min(1).max(2000).describe("the finding, one self-contained sentence or two"),
        agent: AGENT_NAME.optional().describe("your agent name (authorship shown in the sidebar)"),
      },
    },
    async ({ text, agent }) => {
      try {
        const pin = deps.pins.create(text, agent ?? "agent");
        deps.onPinsChanged?.();
        return ok(`pinned as ${pin.id}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_pins",
    {
      description: "Read the project's shared checklist — check it before starting work to avoid re-discovering what's already known.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(JSON.stringify(deps.pins.list(), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "complete_pin",
    {
      description: "Mark a pin done (or reopen it with done=false).",
      inputSchema: {
        id: z.string().regex(/^p-[0-9a-f]{6}$/).describe("pin id from list_pins"),
        done: z.boolean().default(true),
      },
    },
    async ({ id, done }) => {
      try {
        const pin = deps.pins.setDone(id, done);
        deps.onPinsChanged?.();
        return ok(`pin ${pin.id} ${done ? "completed" : "reopened"}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_notes",
    {
      description: "Read the project's shared free-form notes (.tachyon/notes.md) — the team whiteboard.",
      inputSchema: {},
    },
    async () => {
      try {
        const notes = deps.pins.getNotes();
        return ok(notes.length > 0 ? notes : "(notes are empty)");
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "set_notes",
    {
      description:
        "Replace the project's shared notes (.tachyon/notes.md). REPLACES the whole content — " +
        "call get_notes first and merge if you mean to append. Use for coordination state: " +
        "work division, do-not-touch zones, decisions.",
      inputSchema: {
        text: z.string().max(50000).describe("the full new notes content (markdown)"),
      },
    },
    async ({ text }) => {
      try {
        deps.pins.setNotes(text);
        deps.onPinsChanged?.();
        return ok("notes updated");
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
