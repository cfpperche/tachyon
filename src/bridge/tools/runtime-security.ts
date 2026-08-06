import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BridgeDeps, fail, ok } from "./shared.js";

export function registerRuntimeSecurityTools(mcp: McpServer, deps: BridgeDeps): void {

  mcp.registerTool(
    "reconcile_runtime_credentials",
    {
      description: "t-14cf7c — list orphan runtime homes that retain credentials, or retire credentials for explicitly named orphan agents. Cache is retained. Every apply re-proves the agent is absent and the home is unoccupied and unchanged; there is no unattended sweep. Run dry_run first.",
      inputSchema: {
        dry_run: z.boolean().optional().default(true),
        agent_names: z.array(z.string().min(1)).optional().default([]).describe("exact orphan names to reconcile; required for apply"),
      },
    },
    async ({ dry_run, agent_names }) => {
      try {
        if (!deps.runtimeCredentialHygiene) return fail(new Error("runtime credential hygiene is not available on this Bridge"));
        if (!dry_run && agent_names.length === 0) return fail(new Error("apply requires at least one explicit agent_names entry"));
        return ok(JSON.stringify(await deps.runtimeCredentialHygiene({ dryRun: dry_run, agentNames: agent_names }), null, 2));
      } catch (error) { return fail(error); }
    },
  );
}
