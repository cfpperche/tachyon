import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listPendingApprovalRequests } from "../approvalRequest.js";
import { type BridgeDeps, AGENT_NAME, contextRenewalRequestRefusal, fail, ok, resolveDeclaredActor } from "./shared.js";

export function registerContinuityTools(mcp: McpServer, deps: BridgeDeps): void {

  // spec 241 — per-agent continuity: YOUR private working memory, re-injected when you cross a discontinuity
  // (compaction / clear / new session / restart). Distinct from pins (shared) and the role doc (contract).
  mcp.registerTool(
    "get_continuity",
    {
      description:
        "Read YOUR continuity brief (.tachyon/continuity/<agent>.md) — your saved working state " +
        "(current goal, decisions, next steps, open threads). Call this after a compaction / new session / " +
        "restart to rebuild what you were doing. Returns '(no continuity brief yet)' on a cold start.",
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
        const brief = deps.continuity.read(selfActor.name);
        if (!brief) return ok("(no continuity brief yet — create one with set_continuity once your goal/state are clear)");
        return ok(`---\n${JSON.stringify(brief.meta)}\n---\n${brief.body}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "set_continuity",
    {
      description:
        "Checkpoint YOUR working state into your continuity brief (.tachyon/continuity/<agent>.md). REPLACES " +
        "the whole brief — keep it SHORT and current. Use these markdown sections: '# Current Goal' (your " +
        "current execution objective, not your task contract), '# Working State', '# Decisions', '# Next Steps', " +
        "'# Open Threads', '# Files / Artifacts In Play'. Tachyon stamps the metadata. Update it before a likely " +
        "compaction and whenever your plan changes — a stale brief misleads your future self.",
      inputSchema: {
        agent: AGENT_NAME.describe(
          "your EXACT Tachyon agent name (as shown in Tachyon's nudge / the sidebar, and in your $TACHYON_AGENT_NAME env var) — " +
            "do NOT guess; a wrong name writes the brief to the wrong file",
        ),
        content: z.string().max(20000).describe("the full brief body (markdown sections above)"),
        status: z.enum(["active", "paused", "blocked", "done"]).optional().describe("active (default) | paused | blocked | done"),
        source_activity_seq: z.number().int().nonnegative().optional().describe("usually omit — Tachyon anchors freshness to the current activity seq"),
      },
    },
    async ({ agent, content, status, source_activity_seq }) => {
      try {
        if (!deps.continuity) return fail(new Error("continuity is not available"));
        const selfActor = resolveDeclaredActor(deps, agent);
        if (!selfActor.ok) return fail(new Error(selfActor.message));
        if (!selfActor.name) return fail(new Error("set_continuity requires a resolvable agent identity"));
        const self = selfActor.name;
        const res = deps.continuity.write(self, content, {
          updatedBy: "agent",
          status,
          sourceActivitySeq: source_activity_seq ?? deps.currentActivitySeq?.(self),
        });
        deps.onContinuityChanged?.(self);
        return ok(res.warning ? `continuity updated — ${res.warning}` : "continuity updated");
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "continuity_status",
    {
      description:
        "Report the freshness of an agent's continuity brief: whether it exists, its status, when it was last " +
        "updated, and how far behind current activity it is (lag). Use to decide whether to re-read or refresh it.",
      inputSchema: { agent: AGENT_NAME.describe("the agent name") },
    },
    async ({ agent }) => {
      try {
        if (!deps.continuity) return fail(new Error("continuity is not available"));
        const brief = deps.continuity.read(agent);
        if (!brief) return ok(JSON.stringify({ agent, exists: false }));
        const cur = deps.currentActivitySeq?.(agent);
        const seq = typeof brief.meta.source_activity_seq === "number" ? brief.meta.source_activity_seq : undefined;
        const lag = cur !== undefined && seq !== undefined ? Math.max(0, cur - seq) : undefined;
        return ok(
          JSON.stringify({
            agent,
            exists: true,
            status: brief.meta.status,
            updated_at: brief.meta.updated_at,
            updated_by: brief.meta.updated_by,
            source_activity_seq: seq,
            current_activity_seq: cur,
            lag,
          }),
        );
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
