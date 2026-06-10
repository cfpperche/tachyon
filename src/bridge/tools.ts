import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentManager } from "../agents/AgentManager.js";
import type { TmuxService } from "../tmux/TmuxService.js";
import type { PinStore } from "../pins/PinStore.js";
import type { Waiters, WaitCondition } from "./Waiters.js";
import type { CommandRunner } from "../commands/CommandRunner.js";
import type { RunbookRunner } from "../commands/RunbookRunner.js";

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
  /** Event-driven waiter registry — enables wait_for_agent (absent = tool returns an error). */
  waiters?: Waiters;
  /** One-shot command runner — enables run_command/list_commands. */
  commands?: CommandRunner;
  /** Step-by-step runbook runner — enables run_runbook. */
  runbooks?: RunbookRunner;
}

/** Waiter key namespace for command completions (no clash with agent names). */
export const CMD_WAIT_PREFIX = "cmd:";

/** Shared by the MCP tool and the extension's internal command — one wait semantics. */
export async function executeWait(
  deps: Pick<BridgeDeps, "manager" | "attentionOf" | "waiters">,
  name: string,
  until: WaitCondition,
  timeoutSec: number,
): Promise<{ met: boolean; state: string; exitCode?: number; waitedMs: number }> {
  const states = await deps.manager.agentStates();
  const current = states.get(name);
  if (!current) return { met: until === "dead", state: "gone", waitedMs: 0 };
  if (current.dead) return { met: until === "dead", state: "dead", exitCode: current.exitCode, waitedMs: 0 };
  const attention = deps.attentionOf?.(name);
  if (attention === until) return { met: true, state: attention, waitedMs: 0 };
  if (!deps.waiters) throw new Error("waiting is not available on this Bridge");
  const result = await deps.waiters.wait(name, until, timeoutSec * 1000);
  if (result.state === "timeout") {
    // report the live state at timeout so the caller can decide (and call again)
    return { ...result, state: deps.attentionOf?.(name) ?? "working" };
  }
  return result;
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
        "ALWAYS pass parent=<your own agent name> so the sidebar shows lineage. " +
        "For NON-BLOCKING delegation, tell the child in its instructions to save its result with " +
        "set_notes and call notify when done — then you don't need wait_for_agent at all. " +
        "Subject to the maxAgents guardrail.",
      inputSchema: {
        name: AGENT_NAME.describe("agent name (becomes part of the tmux session name)"),
        cmd: z.string().min(1).optional().describe("shell command for an ad-hoc agent; omit to use tachyon.yml"),
        cwd: z.string().optional().describe("working directory for an ad-hoc agent"),
        instructions: z
          .string()
          .max(2000)
          .optional()
          .describe("role prompt for the new agent — delivered as a startup prompt for claude/codex/gemini"),
        parent: AGENT_NAME.optional().describe("YOUR agent name — records who spawned this agent (lineage)"),
      },
    },
    async ({ name, cmd, cwd, instructions, parent }) => {
      try {
        await deps.manager.spawn(name, { cmd, cwd, instructions, parent });
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
    "run_command",
    {
      description:
        "Run a command from the project's CURATED list (commands: in tachyon.yml) and block until it " +
        "finishes — the safe way to execute project operations (tests, lint, build) instead of typing " +
        "into a shell. Returns {passed, exitCode, durationMs, tail} with the last output lines. " +
        "On timeout the run keeps going; call again with the same name to keep waiting (a finished " +
        "run reports its result; it does NOT re-run — use rerun=true to force a fresh run).",
      inputSchema: {
        name: AGENT_NAME.describe("command name from tachyon.yml's commands: map"),
        timeoutSec: z.number().int().min(1).max(240).default(120),
        rerun: z.boolean().default(false).describe("force a fresh run even if a finished result exists"),
      },
    },
    async ({ name, timeoutSec, rerun }) => {
      try {
        if (!deps.commands) return fail(new Error("commands are not available on this Bridge"));
        const before = await deps.commands.status(name);
        if (!before.declared) return fail(new Error(`unknown command '${name}'`));
        if (before.state === "running") {
          // already in flight — just wait on it
        } else if (before.state === "idle" || rerun) {
          await deps.commands.run(name);
        } else {
          // finished result available and no rerun requested — report it
          const tail = await deps.commands.tail(name);
          return ok(JSON.stringify({ name, passed: before.state === "passed", exitCode: before.exitCode, tail, rerun: false }));
        }
        if (!deps.waiters) return fail(new Error("waiting is not available on this Bridge"));
        const result = await deps.waiters.wait(`${CMD_WAIT_PREFIX}${name}`, "dead", timeoutSec * 1000);
        if (result.state === "timeout") {
          return ok(JSON.stringify({ name, running: true, note: "still running — call again to keep waiting" }));
        }
        const tail = await deps.commands.tail(name);
        return ok(
          JSON.stringify({
            name,
            passed: result.exitCode === 0,
            exitCode: result.exitCode,
            durationMs: result.waitedMs,
            tail,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_commands",
    {
      description: "List the project's curated one-shot commands and their last results.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!deps.commands) return fail(new Error("commands are not available on this Bridge"));
        return ok(JSON.stringify(await deps.commands.list(), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "run_runbook",
    {
      description:
        "Run a step-by-step procedure from the project's runbooks: map (steps are curated commands " +
        "or inline shell, sequential, stopping at the first non-zero exit). Blocks up to timeoutSec; " +
        "if it times out the runbook KEEPS RUNNING — call again with the same name for progress or " +
        "the final result (a finished job is reported, NOT re-run; pass rerun=true for a fresh run). " +
        "Returns the job with per-step exit codes and durations.",
      inputSchema: {
        name: AGENT_NAME.describe("runbook name from tachyon.yml's runbooks: map"),
        timeoutSec: z.number().int().min(1).max(240).default(180),
        rerun: z.boolean().default(false).describe("force a fresh run even if a finished job exists"),
      },
    },
    async ({ name, timeoutSec, rerun }) => {
      try {
        if (!deps.runbooks) return fail(new Error("runbooks are not available on this Bridge"));
        let jobPromise: Promise<unknown> | undefined;
        if (!deps.runbooks.isRunning(name)) {
          const last = deps.runbooks.currentJob(name);
          if (last && !rerun) {
            // finished job available and no rerun requested — report it
            return ok(JSON.stringify(last));
          }
          jobPromise = deps.runbooks.run(name); // rejects on unknown runbook
        }
        const deadline = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutSec * 1000));
        const settled = await Promise.race([jobPromise ?? deadline, deadline]);
        const job = deps.runbooks.currentJob(name);
        if (settled === "timeout" && deps.runbooks.isRunning(name)) {
          return ok(JSON.stringify({ name, running: true, progress: job, note: "still running — call again for the result" }));
        }
        return ok(JSON.stringify(job));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "wait_for_agent",
    {
      description:
        "Block until another agent reaches a state — the efficient way to wait for a sub-agent " +
        "you spawned: spawn_agent -> wait_for_agent(until=idle) -> read_output/get_notes -> kill_agent. " +
        "NOTE: this holds YOUR turn; if you have other work (or the human needs you responsive), " +
        "prefer non-blocking delegation: instruct the child to set_notes + notify when done. " +
        "idle = stopped producing output (likely finished); needs-input = waiting for a prompt; " +
        "dead = process ended. Returns {met, state, exitCode?, waitedMs}; on met=false (timeout) " +
        "the current state is returned — just call again to keep waiting.",
      inputSchema: {
        name: AGENT_NAME,
        until: z.enum(["idle", "needs-input", "dead"]).describe("state to wait for"),
        timeoutSec: z
          .number()
          .int()
          .min(1)
          .max(240)
          .default(45)
          .describe("max seconds to hold this call (your MCP client may impose its own limit)"),
      },
    },
    async ({ name, until, timeoutSec }) => {
      try {
        return ok(JSON.stringify(await executeWait(deps, name, until, timeoutSec)));
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
