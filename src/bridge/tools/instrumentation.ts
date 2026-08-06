import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sealExecutionEvent } from "../../executionGraph/eventSchema.js";
import { mintExecution, mintToolCall } from "../../executionGraph/executionIdentity.js";
import { BRIDGE_CALL, type BridgeDeps } from "./shared.js";

export type BridgeExecutionHooks = {
  emitExecution: (raw: Parameters<typeof sealExecutionEvent>[0]) => void;
  executionCallerId: () => string;
};

/**
 * SDD 480 Phase 2 / §7.3 — wrap MCP registration so every Bridge tool call becomes an
 * InternalOperation. Extracted from registerTools (t-3b47ad); behavior unchanged.
 */
export function instrumentBridge(mcp: McpServer, deps: BridgeDeps): { mcp: McpServer } & BridgeExecutionHooks {
  /**
   * SDD 480 Phase 2 — seal one execution event and hand it to the sink, never throwing.
   *
   * Shared by every Bridge seam so the swallow-and-continue rule is written once: a diagnostic that
   * can fail the operation it observes is worse than no diagnostic.
   */
  const emitExecution = (raw: Parameters<typeof sealExecutionEvent>[0]): void => {
    if (!deps.recordExecution) return;
    try { deps.recordExecution(sealExecutionEvent(raw)); } catch { /* observation only */ }
  };
  /**
   * Who a Bridge tool call belongs to. An agent arm with no name is `unattributed-caller` rather than
   * borrowing `human` or the nearest agent: paired with the `unproven` provenance beside it, it says
   * "we recorded this and cannot tell you whose it was", which is the honest answer.
   */
  const executionCallerId = (): string =>
    deps.caller?.kind === "agent" ? (deps.caller.name ?? "unattributed-caller") : "human";

  /**
   * SDD 480 §7.3 — EVERY Bridge tool call becomes an `InternalOperation`.
   *
   * Done by wrapping registration once rather than by touching a hundred handlers. That is not only
   * less code: a per-handler emit is a rule every future tool has to remember, and §7.3 is exactly
   * the kind of "every" that decays the first time someone forgets. Wrapping here means a tool cannot
   * be added without being recorded.
   *
   * What is recorded is the tool NAME, the outcome and the duration — never the arguments. A Bridge
   * call's args routinely carry task bodies, handoff prose and tokens; the cheapest way to keep a
   * secret out of the ledger is not to collect it. §7.3 asks for sanitized metadata, and the name of
   * the operation is the metadata that makes the graph legible.
   *
   * `carrier: "absent"` throughout: a Bridge call is work done inside this process. There is no child
   * to hand an environment to, so nothing here could later be proven to be this operation.
   */
  const instrument = (target: McpServer): McpServer => {
    if (!deps.recordExecution) return target;
    // The SDK's `registerTool` is generic over its input/output schemas, and the wrapper is
    // deliberately indifferent to both — it only ever adds behaviour around the handler. Erasing the
    // generics through one local alias keeps that single cast contained here instead of leaking a
    // loosened signature to the hundred call sites below, which stay fully typed.
    type Register = (name: string, schema: never, handler: (...args: never[]) => Promise<unknown>) => unknown;
    const originalRegister = target.registerTool.bind(target) as unknown as Register;
    const wrapped = Object.create(target) as McpServer;
    (wrapped as unknown as { registerTool: Register }).registerTool = (name, schema, handler) =>
      originalRegister(name, schema, async (...args: never[]) => {
        // §3.4 gap 1 — the tool call gets an identity, minted BEFORE the handler runs so anything the
        // handler starts can point back at it. §3.4 gap 2 — that identity is published on the async
        // context, which is how an execution born inside the handler joins to the call that caused it.
        const { toolCallId } = mintToolCall({ tool: name });
        const minted = mintExecution({ agentId: executionCallerId(), carrier: "absent", toolCallId });
        const startedAt = Date.now();
        emitExecution({
          kind: "spawn", node: "InternalOperation", state: "running", provenance: minted.provenance,
          correlation: minted.correlation, at: new Date().toISOString(),
          detail: { tool: name },
        });
        try {
          // AsyncLocalStorage rather than a module variable: Bridge handlers interleave, and a shared
          // mutable "current call" would attribute one tool's child process to whichever call happened
          // to be in flight — the confident wrong parent §5 rules out.
          const result = await BRIDGE_CALL.run({ toolCallId, executionId: minted.executionId }, () => handler(...args));
          // An MCP tool reports failure by RETURNING `isError`, not by throwing, so a wrapper that
          // only watched for exceptions would record every refusal as a success.
          const failed = !!(result as { isError?: boolean } | undefined)?.isError;
          emitExecution({
            kind: failed ? "fail" : "exit", node: "InternalOperation",
            state: failed ? "failed" : "completed",
            provenance: minted.provenance, correlation: minted.correlation, at: new Date().toISOString(),
            detail: { tool: name, durationMs: Date.now() - startedAt },
          });
          return result;
        } catch (err) {
          emitExecution({
            kind: "fail", node: "InternalOperation", state: "failed", provenance: minted.provenance,
            correlation: minted.correlation, at: new Date().toISOString(),
            detail: { tool: name, durationMs: Date.now() - startedAt, error: String(err) },
          });
          throw err;
        }
      });
    return wrapped;
  };
  return { mcp: instrument(mcp), emitExecution, executionCallerId };
}
