import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mintExecution } from "../../executionGraph/executionIdentity.js";
import { hostActionName } from "../../host-action/index.js";
import { type BridgeDeps, fail, ok } from "./shared.js";
import type { BridgeExecutionHooks } from "./instrumentation.js";

export function registerHostActionTools(mcp: McpServer, deps: BridgeDeps, hooks: BridgeExecutionHooks): void {
  const { emitExecution, executionCallerId } = hooks;







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
      // SDD 480 §3.1 — minted BEFORE the broker call, so a host action that hangs or throws still left
      // a record that it was attempted. `carrier: "absent"` is the honest declaration: the action runs
      // inside the VS Code host, so there is no child of ours to hand an environment to and no process
      // that could later be proven to be this execution. Recorded anyway, labelled `unproven`.
      const minted = mintExecution({ agentId: executionCallerId(), carrier: "absent" });
      const name = hostActionName(action);
      try {
        if (!deps.runHostAction) return fail(new Error("host actions are not available on this Bridge"));
        emitExecution({
          kind: "spawn", node: "Process", state: "running", provenance: minted.provenance,
          correlation: minted.correlation, at: new Date().toISOString(),
          detail: { tool: "run_host_action", action: name },
        });
        const result = await deps.runHostAction({ action: name, args, timeoutMs, caller: deps.caller ?? { kind: "legacy" } });
        emitExecution({
          kind: "exit", node: "Process", state: "completed", provenance: minted.provenance,
          correlation: minted.correlation, at: new Date().toISOString(),
          detail: { tool: "run_host_action", action: name },
        });
        return ok(JSON.stringify(result, null, 2));
      } catch (err) {
        emitExecution({
          kind: "fail", node: "Process", state: "failed", provenance: minted.provenance,
          correlation: minted.correlation, at: new Date().toISOString(),
          detail: { tool: "run_host_action", action: name, error: String(err) },
        });
        return fail(err);
      }
    },
  );
}
