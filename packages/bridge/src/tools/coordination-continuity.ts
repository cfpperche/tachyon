import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listPendingApprovalRequests } from "@tachyon/engine/approvals/approvalRequest.js";
import { type BridgeDeps, AGENT_NAME, contextRenewalRequestRefusal, fail, ok, resolveDeclaredActor } from "./shared.js";

export function registerContinuityTools(mcp: McpServer, deps: BridgeDeps): void {

  // Per-agent plain Markdown working memory. Distinct from pins (shared) and the role doc (contract).
  mcp.registerTool(
    "get_continuity",
    {
      description:
        "Read YOUR saved continuity file (.tachyon/continuity/<agent>.md). Returns '(no continuity brief yet)' when absent.",
      inputSchema: { agent: AGENT_NAME.describe("your agent name — the value of your $TACHYON_AGENT_NAME env var; never guess it") },
    },
    async ({ agent }) => {
      try {
        if (!deps.continuity) return fail(new Error("continuity is not available"));
        // spec 351 — your own continuity is an ACTOR param: omitted -> resolved caller; a different name is
        // a structured mismatch (reading someone ELSE's private working memory is not a legitimate case).
        const selfActor = resolveDeclaredActor(deps, agent);
        if (!selfActor.ok) return fail(new Error(selfActor.message));
        if (!selfActor.name) return fail(new Error("get_continuity requires a resolvable agent identity"));
        return ok(deps.continuity.read(selfActor.name) ?? "(no continuity brief yet)");
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "set_continuity",
    {
      description:
        "Write YOUR saved continuity file (.tachyon/continuity/<agent>.md). This replaces the file's Markdown content.",
      inputSchema: {
        agent: AGENT_NAME.describe(
          "your EXACT Tachyon agent name (as shown in Tachyon's nudge / the sidebar, and in your $TACHYON_AGENT_NAME env var) — " +
            "do NOT guess; a wrong name writes the brief to the wrong file",
        ),
        content: z.string().max(20000).describe("the complete Markdown file content"),
      },
    },
    async ({ agent, content }) => {
      try {
        if (!deps.continuity) return fail(new Error("continuity is not available"));
        const selfActor = resolveDeclaredActor(deps, agent);
        if (!selfActor.ok) return fail(new Error(selfActor.message));
        if (!selfActor.name) return fail(new Error("set_continuity requires a resolvable agent identity"));
        deps.continuity.write(selfActor.name, content);
        return ok("continuity updated");
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "renew_context",
    {
      description:
        "Renew YOUR OWN runtime context after this turn becomes idle. mode='compact' preserves a summary; " +
        "mode='fresh' destroys conversational context and is refused without a continuity brief. The pending " +
        "intent is replaceable, so repeated calls produce one gesture, never a queue.",
      inputSchema: { mode: z.enum(["compact", "fresh"]) },
    },
    async ({ mode }) => {
      try {
        const selfActor = resolveDeclaredActor(deps, undefined);
        if (!selfActor.ok) return fail(new Error(selfActor.message));
        if (!selfActor.name) return fail(new Error("renew_context requires a resolvable agent identity"));
        const self = selfActor.name;
        const pendingApproval = listPendingApprovalRequests(deps.workspaceRoot).find((row) => row.requester === self);
        const brief = mode === "fresh" ? deps.continuity?.read(self) : undefined;
        const refusal = contextRenewalRequestRefusal({
          agent: self,
          mode,
          composerOccupied: deps.composerOccupiedOf?.(self) === true,
          pendingApprovalId: pendingApproval?.id,
          attention: deps.attentionOf?.(self),
          continuityExists: !!brief,
        });
        if (refusal) return fail(new Error(refusal));

        if (mode === "compact") {
          if (!deps.requestContextCompaction) return fail(new Error("context compaction is not available on this Bridge"));
          return ok(JSON.stringify(await deps.requestContextCompaction(self)));
        }

        if (!deps.requestFreshContext) return fail(new Error("fresh context renewal is not available on this Bridge"));
        return ok(JSON.stringify(await deps.requestFreshContext(self)));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
