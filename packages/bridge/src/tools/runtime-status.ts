import { z } from "zod";
import { type BridgeDeps, fail, ok } from "./shared.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerRuntimeStatusTools(mcp: McpServer, deps: BridgeDeps): void {
  mcp.registerTool(
    "runtime_status_publish",
    {
      description: "Publish a native lifecycle edge from the current Tachyon-managed runtime process.",
      inputSchema: {
        event: z.literal("stopped"),
        runtime: z.enum(["claude", "codex", "grok"]),
      },
    },
    async ({ event }) => {
      const caller = deps.caller;
      if (caller?.kind !== "agent" || !caller.name) return fail(new Error("runtime status requires an authenticated agent bearer"));
      if (caller.credentialState !== "live") return fail(new Error("runtime status belongs to a previous agent session"));
      if (!deps.publishRuntimeStatus) return fail(new Error("runtime status ingest is unavailable"));
      if (!deps.publishRuntimeStatus(caller.name, event)) return fail(new Error("agent attention is not currently tracked"));
      return ok(JSON.stringify({ accepted: true, agent: caller.name, event }));
    },
  );
}
