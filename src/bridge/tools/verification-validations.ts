import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validationSummary } from "../../validations/ValidationStore.js";
import { nextValidation } from "../../validations/nextValidation.js";
import { discoverValidationCandidates } from "../../validations/discovery.js";
import { type BridgeDeps, AGENT_NAME, TASK_ARTIFACT_REF, TASK_PRIORITY, VALIDATION_EXECUTOR, VALIDATION_EXPECT, VALIDATION_ID, VALIDATION_OUTCOME, VALIDATION_STATUS, definedPatch, fail, ok, validationActor } from "./shared.js";

export function registerValidationTools(mcp: McpServer, deps: BridgeDeps): void {

  // spec 344 — validation queue: verification/dogfood/manual checks are separate from Tasks and SDD.
  mcp.registerTool(
    "create_validation",
    {
      description:
        "Create a project Validation in the shared validation queue. Validations are checks that still need proof " +
        "(dogfood, manual QA, review, external verification). The `type` field is open text, so projects can use " +
        "their own vocabulary; `executor` is closed so Tachyon can route human-only vs agent-capable work.",
      inputSchema: {
        title: z.string().min(1).max(300),
        type: z.string().min(1).max(64).optional(),
        executor: VALIDATION_EXECUTOR.default("either"),
        priority: TASK_PRIORITY.optional(),
        assignee: z.string().min(1).max(64).optional(),
        instructions: z.string().max(4000).optional(),
        source_refs: z.array(TASK_ARTIFACT_REF).max(10).optional(),
        agent: AGENT_NAME.optional().describe(
          "your agent name; omitted means human-created. It's the value of your $TACHYON_AGENT_NAME env var; never guess it.",
        ),
      },
    },
    async ({ title, type, executor, priority, assignee, instructions, source_refs, agent }) => {
      try {
        const author = agent ?? "human";
        const validation = await deps.validations.create({ title, author, type, executor, priority, assignee, instructions, source_refs });
        deps.onValidationsChanged?.();
        if (validation.executor === "human") {
          deps.onHumanValidationPending?.({ id: validation.id, title: validation.title, author });
        }
        return ok(JSON.stringify(validation, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_validation",
    {
      description: "Read one full Validation, including all completed rounds and their proof notes/evidence refs.",
      inputSchema: { id: VALIDATION_ID.describe("validation id from list_validations or next_validation") },
    },
    async ({ id }) => {
      try {
        return ok(JSON.stringify(deps.validations.get(id), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "update_validation",
    {
      description:
        "Patch a Validation. Use expect:{assignee:null} when claiming an unassigned validation returned by " +
        "next_validation; precondition failures are structured errors and mean you must re-query. An agent cannot " +
        "change the executor of a validation reserved for a human ('human') — only a human hands that work to the fleet.",
      inputSchema: {
        id: VALIDATION_ID,
        title: z.string().min(1).max(300).optional(),
        type: z.string().min(1).max(64).nullable().optional(),
        status: VALIDATION_STATUS.optional(),
        executor: VALIDATION_EXECUTOR.optional(),
        priority: TASK_PRIORITY.nullable().optional(),
        assignee: z.string().min(1).max(64).nullable().optional(),
        instructions: z.string().max(4000).nullable().optional(),
        source_refs: z.array(TASK_ARTIFACT_REF).max(10).nullable().optional(),
        expect: VALIDATION_EXPECT,
      },
    },
    async ({ id, title, type, status, executor, priority, assignee, instructions, source_refs, expect }) => {
      try {
        const patch = definedPatch({ title, type, status, executor, priority, assignee, instructions, source_refs, expect });
        const changedFields = Object.keys(patch).filter((key) => key !== "expect");
        if (changedFields.length === 0) {
          throw new Error("update_validation requires at least one field");
        }
        // read BEFORE the write, so the signal fires on the transition rather than on every patch of
        // an already-human validation (a re-titled one must not re-notify).
        let wasHuman: boolean | undefined;
        try {
          wasHuman = deps.validations.get(id).executor === "human";
        } catch {
          /* the update below reports the real failure */
        }
        const validation = await deps.validations.update(id, { ...patch, actor: validationActor(deps) });
        deps.onValidationsChanged?.();
        if (validation.executor === "human" && wasHuman === false) {
          const actor = validationActor(deps);
          deps.onHumanValidationPending?.({
            id: validation.id,
            title: validation.title,
            // who handed it over, in the same self-declared terms the record itself uses
            author: actor.kind === "agent" && actor.name ? actor.name : "human",
          });
        }
        return ok(JSON.stringify(validation, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_validations",
    {
      description: "List bounded Validation summaries for Mission Control. Omits instructions; use get_validation for full detail.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ limit }) => {
      try {
        return ok(JSON.stringify(deps.validations.list(limit).map(validationSummary), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "next_validation",
    {
      description:
        "Return the single best Validation for an assignee to run next. Advisory only: claim unassigned work with " +
        "update_validation(id, assignee:<you>, expect:{assignee:null}) before doing the check. Human-only validations are never handed to agents.",
      inputSchema: {
        agent: z.string().min(1).max(64).describe("assignee asking for validation work; use 'human' for the human queue"),
      },
    },
    async ({ agent }) => {
      try {
        return ok(JSON.stringify(nextValidation({ validations: deps.validations.list(500), agent }), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "close_validation",
    {
      description:
        "Close the current Validation round with an outcome. Must include result_note or evidence_refs; Tachyon " +
        "stores failed/skipped rounds so a later rerun can add a new round instead of erasing history. A validation " +
        "with executor 'human' is reserved: an agent cannot close it, and cannot hand it to itself by changing the " +
        "executor either — ask the human to close it in Control → Validations. The round records who closed it, " +
        "resolved by the Bridge from your token rather than from anything you can declare.",
      inputSchema: {
        id: VALIDATION_ID,
        outcome: VALIDATION_OUTCOME,
        result_note: z.string().min(1).max(4000).optional(),
        evidence_refs: z.array(TASK_ARTIFACT_REF).max(10).optional(),
        assignee: z.string().min(1).max(64).optional(),
        expect: VALIDATION_EXPECT,
      },
    },
    async ({ id, outcome, result_note, evidence_refs, assignee, expect }) => {
      try {
        const validation = await deps.validations.closeRound(id, { actor: validationActor(deps), outcome, result_note, evidence_refs, assignee, expect });
        deps.onValidationsChanged?.();
        return ok(JSON.stringify(validation, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "discover_validation_candidates",
    {
      description:
        "Discover likely validation debt from existing local specs, tasks, and pins without creating records. " +
        "This is a review/import aid for existing dogfoods; it is best-effort and SDD-independent.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ limit }) => {
      try {
        return ok(JSON.stringify(discoverValidationCandidates(deps.workspaceRoot, limit), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
