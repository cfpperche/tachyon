import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BridgeDeps, fail, ok } from "./shared.js";

export function registerNotifyTool(mcp: McpServer, deps: BridgeDeps): void {

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
        // t-18a658 — attribute agent-authored notifications with the Bridge-resolved caller (never
        // an input the agent could spoof); non-agent principals keep the unprefixed message.
        const caller = deps.caller ?? { kind: "legacy" as const };
        const prefix = caller.kind === "agent" && caller.name ? `[${caller.name}] ` : "";
        deps.notify(`${prefix}${message}`, level);
        return ok("notification shown");
      } catch (err) {
        return fail(err);
      }
    },
  );
}
