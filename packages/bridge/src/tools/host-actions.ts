import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostActionName } from "@tachyon/engine/host-action/index.js";
import { type BridgeDeps, fail, ok } from "./shared.js";

export function registerHostActionTools(mcp: McpServer, deps: BridgeDeps): void {
  mcp.registerTool(
    "run_host_action",
    {
      description:
        "Run a governed host action through the host-action broker. The Bridge-resolved caller identity is used automatically; " +
        "never pass a caller/agent parameter. Default-deny when the external host-action policy is absent, hash-mismatched, or does not grant this caller.",
      inputSchema: {
        action: z.string().min(1).max(128).describe("host-neutral action name, e.g. reloadWindow"),
        args: z.unknown().optional().describe("closed-schema JSON args for the action; reloadWindow takes no args"),
        timeoutMs: z.number().int().min(1).max(120_000).optional(),
      },
    },
    async ({ action, args, timeoutMs }) => {
      const name = hostActionName(action);
      try {
        if (!deps.runHostAction) return fail(new Error("host actions are not available on this Bridge"));
        const result = await deps.runHostAction({ action: name, args, timeoutMs, caller: deps.caller ?? { kind: "legacy" } });
        return ok(JSON.stringify(result, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
