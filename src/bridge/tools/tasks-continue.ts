import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_NAME, fail, ok } from "./shared.js";
import type { BridgeDeps } from "./shared.js";

export function registerContinueTaskTool(mcp: McpServer, deps: BridgeDeps): void {

  mcp.registerTool(
    "continue_task",
    {
      description:
        "Continue an unfinished task on a DIFFERENT declared agent (t-7551f9). Writes a focused " +
        "handoff under .tachyon/session-continuation/ and spawns the destination as a NEW session " +
        "with that handoff as task brief. Does NOT migrate native resume/tool state; does NOT stop " +
        "the source agent; does NOT change cmd on the source. Use when the source runtime hit a " +
        "limit or you want another CLI family on the same work — not for same-runtime resume/fork.",
      inputSchema: {
        from_agent: AGENT_NAME.describe("agent that was working on the task"),
        to_agent: AGENT_NAME.describe("declared agent to start fresh with a different (or same-family) runtime"),
        reason: z.string().max(2000).optional().describe("why you are continuing (e.g. usage limit)"),
        task_summary: z.string().max(8000).optional().describe("short task goal / current state summary"),
      },
    },
    async ({ from_agent, to_agent, reason, task_summary }) => {
      try {
        if (!deps.continueTask) return fail(new Error("continue_task is not available on this Bridge"));
        const result = await deps.continueTask({
          fromAgent: from_agent,
          toAgent: to_agent,
          reason,
          taskSummary: task_summary,
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
