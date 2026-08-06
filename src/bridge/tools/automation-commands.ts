import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mintExecution } from "../../executionGraph/executionIdentity.js";
import { type BridgeDeps, AGENT_NAME, BRIDGE_CALL, CMD_WAIT_PREFIX, fail, ok } from "./shared.js";
import type { BridgeExecutionHooks } from "./instrumentation.js";

export function registerCommandTools(mcp: McpServer, deps: BridgeDeps, hooks: BridgeExecutionHooks): void {
  const { emitExecution, executionCallerId } = hooks;

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
      // Uses the shared `emitExecution` defined once for every Bridge seam.
      let minted: ReturnType<typeof mintExecution> | undefined;
      try {
        if (!deps.commands) return fail(new Error("commands are not available on this Bridge"));
        const before = await deps.commands.status(name);
        if (!before.declared) return fail(new Error(`unknown command '${name}'`));
        if (before.state === "running") {
          // already in flight — just wait on it
        } else if (before.state === "idle" || rerun) {
          // SDD 480 — the ToolCall to execution link. Minted BEFORE the run, so the record exists even
          // if the command dies instantly. `carrier: "absent"` is the honest declaration here: the
          // command runner starts its own session and this seam hands it no environment, so the
          // PROCESS cannot be proven to be this execution. The tool call is still recorded, with
          // provenance saying exactly that, instead of being dropped or guessed at.
          // §3.4 gap 2 — carry the ambient ToolCall id and edge back to the operation that caused this.
          // Without the edge the two executions sit in the graph as strangers, which is the gap: the
          // Bridge knew its caller but emitted nothing an observer could later join on.
          const call = BRIDGE_CALL.getStore();
          minted = mintExecution({
            agentId: executionCallerId(),
            carrier: "absent",
            ...(call ? { toolCallId: call.toolCallId } : {}),
          });
          emitExecution({
            kind: "spawn", node: "TmuxSession", state: "running", provenance: minted.provenance,
            correlation: minted.correlation, at: new Date().toISOString(),
            ...(call ? { edge: { kind: "invoked" as const, toExecutionId: call.executionId } } : {}),
            detail: { tool: "run_command", command: name },
          });
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
        if (minted) {
          emitExecution({
            kind: "exit", node: "TmuxSession",
            state: result.exitCode === 0 ? "completed" : "failed",
            provenance: minted.provenance, correlation: minted.correlation, at: new Date().toISOString(),
            detail: { tool: "run_command", command: name, exitCode: result.exitCode, durationMs: result.waitedMs },
          });
        }
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
}
