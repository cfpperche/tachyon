import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BridgeDeps, AGENT_NAME, fail, ok, resolveDeclaredActor } from "./shared.js";

export function registerHandoffTools(mcp: McpServer, deps: BridgeDeps): void {

  mcp.registerTool(
    "get_project_handoff",
    {
      description:
        "Read the SHARED project handoff (.tachyon/HANDOFF.md) — the curated, project-level state of the WORK " +
        "(current state / active work / next actions / decisions & gotchas), shared by everyone in this workspace. " +
        "This is NOT your per-agent continuity (that is get_continuity). Read it when resuming to learn where the " +
        "project stands. Returns the canonical body + its `revision` (CAS token) + a staleness state + the PENDING " +
        "NOTES (undistilled) + `pending_through` (the distill watermark to echo). To DISTILL: fold `pending` into a " +
        "rewritten body, get the human's OK, then call set_project_handoff(content, expected_revision=revision, " +
        "distilled_through=pending_through). Passing `distilled_through` is what CLEARS the folded notes; a note " +
        "appended after your read stays pending for the next distill (never dropped).",
      inputSchema: { agent: AGENT_NAME.optional().describe("your agent name (optional, for context)") },
    },
    async () => {
      try {
        if (!deps.handoff) return fail(new Error("project handoff is not available"));
        const snap = deps.handoff.snapshot(deps.lastActivityAt?.() ?? null);
        return ok(
          JSON.stringify({
            exists: snap.exists,
            revision: snap.revision,
            pending_notes: snap.pendingCount,
            staleness: snap.staleness,
            body: snap.exists ? snap.body : "(no project handoff yet — append notes, or set_project_handoff to create it)",
            // inc G — the pending note ROWS, so an agent can DISTILL them into the canonical (human curates, agent writes).
            pending: snap.pending.map((n) => ({ ts: n.ts, agent: n.agent, kind: n.kind, summary: n.summary, evidence: n.evidence })),
            // the distill watermark to echo back to set_project_handoff(distilled_through=...): clears exactly the
            // notes you saw here; anything appended after stays pending (codex BLOCK — no concurrent-append loss).
            pending_through: snap.pending.length ? snap.pending[snap.pending.length - 1].ts : "",
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "append_project_handoff_note",
    {
      description:
        "Append ONE structured note to the project handoff's pending lane (.tachyon/handoff-notes.jsonl) — a " +
        "candidate change to the SHARED project state from work you just did. Every agent may append; you do NOT " +
        "rewrite the shared handoff (the human/owner distills notes into it). Use when your work changed project " +
        "state (finished a block, hit a blocker, made a decision, found a gotcha, identified a next step).",
      inputSchema: {
        agent: AGENT_NAME.describe("your EXACT Tachyon agent name — the value of your $TACHYON_AGENT_NAME env var; never guess it"),
        kind: z.enum(["completed", "blocked", "decision", "gotcha", "next"]).describe("what kind of project-state change this note records"),
        summary: z.string().min(1).max(2000).describe("one concise sentence — what changed at the PROJECT level (not your private thread)"),
        evidence: z.array(z.string().max(400)).max(20).optional().describe("optional pointers: files, commands, node ids, commit hashes"),
      },
    },
    async ({ agent, kind, summary, evidence }) => {
      try {
        if (!deps.handoff) return fail(new Error("project handoff is not available"));
        const authorActor = resolveDeclaredActor(deps, agent);
        if (!authorActor.ok) return fail(new Error(authorActor.message));
        if (!authorActor.name) return fail(new Error("append_project_handoff_note requires a resolvable agent identity"));
        const author = authorActor.name;
        deps.handoff.appendNote({ agent: author, kind, summary, evidence });
        deps.onHandoffChanged?.(author); // inc F — anchor the append-nudge to THIS agent's current activity seq
        return ok("handoff note appended (pending distillation by the human/owner)");
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "set_project_handoff",
    {
      description:
        "REWRITE the shared project handoff (.tachyon/HANDOFF.md) in full — reserved for the human/owner (or a " +
        "designated owner agent) distilling pending notes into curated state. Default agents APPEND " +
        "(append_project_handoff_note) instead of calling this. Concurrency-safe: pass `expected_revision` from " +
        "the latest get_project_handoff; if the canonical changed meanwhile the write is REJECTED (re-read + retry). " +
        "Omit expected_revision only for the very first write. When DISTILLING, also pass `distilled_through` = the " +
        "`pending_through` from that same get — it clears exactly the notes you folded in; any note appended after " +
        "your read stays pending for the next distill (never silently dropped).",
      inputSchema: {
        agent: AGENT_NAME.optional().describe("the owner agent name (optional, for attribution)"),
        content: z.string().max(60000).describe("the full canonical handoff body (recommended sections: Current State / Active Work / Next Actions / Decisions & Gotchas)"),
        expected_revision: z.string().optional().describe("the `revision` from your latest get_project_handoff (CAS guard); omit only for the first write"),
        distilled_through: z.string().optional().describe("the `pending_through` from your latest get_project_handoff — advances the distill watermark to clear the notes you folded in. Omit for a non-distilling rewrite (watermark preserved)."),
      },
    },
    async ({ agent, content, expected_revision, distilled_through }) => {
      try {
        if (!deps.handoff) return fail(new Error("project handoff is not available"));
        const res = deps.handoff.setCanonical(content, expected_revision, agent ? "agent" : "human", distilled_through);
        if (!res.ok) {
          return fail(new Error(`rewrite rejected — the handoff changed since you read it (CAS mismatch). Re-read with get_project_handoff and reapply your edit. Current body:\n${res.current}`));
        }
        deps.onHandoffChanged?.();
        return ok(`project handoff updated (revision ${res.revision})`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
