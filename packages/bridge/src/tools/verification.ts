import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Severity } from "@tachyon/engine/worktree/evidence.js";
import { type BridgeDeps, AGENT_NAME, fail, ok, resolveDeclaredActor } from "./shared.js";

export function registerVerificationCoreTools(mcp: McpServer, deps: BridgeDeps): void {
  mcp.registerTool(
    "attach_evidence",
    {
      description:
        "Attach ONE EVIDENCE record to a worktree agent (spec 273): an advisory, a review judgment, " +
        "a Visual-QA verdict + screenshot refs, or a note. Evidence informs readers and never gates/blocks. " +
        "Provide targetAgent, kind (free label e.g. 'judgment'|'advisory'), severity (info|warn|error), a one-line " +
        "summary, and optionally detail, data (structured), artifacts (worktree-relative refs), producer (your " +
        "agent name — provenance, not authentication). Tachyon stamps id/time/commit. Errors if the target has no " +
        "worktree or an artifact ref escapes the worktree.",
      inputSchema: {
        targetAgent: AGENT_NAME.describe("the worktree agent the evidence is about"),
        kind: z.string().min(1).describe("neutral label, e.g. 'judgment' | 'advisory' | 'artifact'"),
        severity: z.enum(["info", "warn", "error"]).describe("advisory severity — never gates"),
        summary: z.string().min(1).describe("one-line, human/agent-readable"),
        detail: z.string().optional().describe("optional durable text/log"),
        data: z.record(z.unknown()).optional().describe("optional structured payload"),
        artifacts: z.array(z.string()).optional().describe("worktree-relative refs (e.g. screenshots); no traversal"),
        producer: z.string().optional().describe(
          "your agent name (provenance, not authentication) — it's the value of your $TACHYON_AGENT_NAME env var; never guess it",
        ),
        onBehalfOf: z.string().optional(),
        sourceRunId: z.string().optional(),
      },
    },
    async ({ targetAgent, kind, severity, summary, detail, data, artifacts, producer, onBehalfOf, sourceRunId }) => {
      try {
        if (!deps.attachEvidence) return fail(new Error("evidence is not available on this Bridge"));
        // spec 351 — producer is an ACTOR param (provenance→identity now that resolution exists);
        // onBehalfOf stays the explicit SUBJECT field for legitimate on-behalf-of attribution (F6).
        const producerActor = resolveDeclaredActor(deps, producer);
        if (!producerActor.ok) return fail(new Error(producerActor.message));
        const r = await deps.attachEvidence({
          targetAgent,
          producer: producerActor.name ?? "unknown",
          kind,
          severity: severity as Severity,
          summary,
          detail,
          data,
          artifacts,
          onBehalfOf,
          sourceRunId,
        });
        return r.ok ? ok(`evidence attached to '${targetAgent}' (id ${r.id})`) : fail(new Error(r.reason ?? "rejected"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_evidence",
    {
      description:
        "Read a worktree agent's non-binary EVIDENCE records (spec 273), newest-first, each flagged fresh/stale " +
        "(stale = the worktree HEAD moved past the commit it was produced against). Use it to read advisories, " +
        "review judgments and other evidence a child produced.",
      inputSchema: { name: AGENT_NAME.describe("the worktree agent whose evidence to read") },
    },
    async ({ name }) => {
      try {
        if (!deps.listEvidence) return fail(new Error("evidence is not available on this Bridge"));
        return ok(JSON.stringify(await deps.listEvidence(name)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "complete_node",
    {
      description:
        "Signal that THIS pipeline node's task is finished (spec 230). Pass runId, nodeId, and nonce " +
        "from your environment (TACHYON_RUN_ID / TACHYON_NODE_ID / TACHYON_NODE_NONCE). The node is " +
        "authenticated by its nonce, not by identity. Errors on a bad token, a non-running node, a " +
        "duplicate signal, or an unknown/closed run. Optionally pass a short `summary` of what you did " +
        "and where (e.g. 'plan in docs/plan.md; chose CSS vars') — it is handed to the next node as " +
        "context.",
      inputSchema: {
        runId: z.string().describe("TACHYON_RUN_ID from your environment"),
        nodeId: z.string().describe("TACHYON_NODE_ID from your environment"),
        nonce: z.string().describe("TACHYON_NODE_NONCE from your environment"),
        summary: z
          .string()
          .optional()
          .describe("optional short handoff for the next node: what you did + where (files, decisions)"),
      },
    },
    async ({ runId, nodeId, nonce, summary }) => {
      try {
        if (!deps.completeNode) return fail(new Error("pipelines are not available on this Bridge"));
        const r = await deps.completeNode({ runId, nodeId, nonce, summary });
        return r.ok ? ok(`node '${nodeId}' completion accepted`) : fail(new Error(r.reason ?? "completion rejected"));
      } catch (err) {
        return fail(err);
      }
    },
  );

}
