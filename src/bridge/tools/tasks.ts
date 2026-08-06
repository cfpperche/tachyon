import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { taskSummary } from "../../tasks/TaskStore.js";
import { TASK_AUTHORING_LIMITS } from "../../tasks/taskAuthoring.js";
import { orderTaskViewsForListing } from "../../tasks/listOrder.js";
import { asAgent } from "../../config/loadConfig.js";
import { TaskPrototypeStore } from "../../tasks/TaskPrototypeStore.js";
import type { EvolutionCandidateInputTarget } from "../../evolution/EvolutionStore.js";
import { type BridgeDeps, AGENT_NAME, CREATE_TASK_ARTIFACT_REF, EVOLUTION_PROPOSAL, EVOLUTION_REVIEW_ID, TASK_ARTIFACT_REF, TASK_AWAITING_HUMAN_KIND, TASK_EXPECT, TASK_ID, TASK_PRIORITY, TASK_STATUS, createTaskLimitErrorMap, createTaskString, definedPatch, emitTaskNotification, fail, notifyTaskJournalAppended, ok, prototypeBridgeView, resolveDeclaredActor, resolvedJournalAuthor, taskNotificationActor, taskReceipt } from "./shared.js";

export function registerTaskTools(mcp: McpServer, deps: BridgeDeps): void {

  // spec 325 — project task queue (Mission Control entity), independent from pins.
  mcp.registerTool(
    "create_task",
    {
      description:
        "Create one bounded, schedulable project Task in the shared Mission Control queue. Tasks are work items, not reminders: " +
        "new tasks land in inbox with no priority/assignee so a human or agent can triage them deliberately. " +
        "Bugs and defects discovered mid-work belong here (kind: 'bug', evidence in the body) — never in pins. " +
        "If a request has four independently shippable slices, create one umbrella Task and explicit follow-up Tasks; " +
        "this tool does not create follow-ups or infer dependencies automatically. Use append_task_note for chronological " +
        "execution context. Keep long material in a durable artifact and point to it with artifact_refs; " +
        "type:'sdd' enables best-effort local spec enrichment only. Never truncate authoring input to fit a limit. " +
        "Answers with a receipt {id,status,author,createdAt} — not the task; read it back with get_task if needed.",
      inputSchema: {
        title: createTaskString("title", TASK_AUTHORING_LIMITS.title).min(1),
        body: createTaskString("body", TASK_AUTHORING_LIMITS.body).optional(),
        kind: createTaskString("kind", TASK_AUTHORING_LIMITS.kind).min(1).optional(),
        artifact_refs: z
          .array(CREATE_TASK_ARTIFACT_REF, { errorMap: createTaskLimitErrorMap("artifact_refs") })
          .max(TASK_AUTHORING_LIMITS.artifactRefs)
          .optional(),
        deps: z.array(TASK_ID).optional(),
        agent: AGENT_NAME.optional().describe(
          "your agent name; omitted means human-created. It's the value of your $TACHYON_AGENT_NAME env var; never guess it.",
        ),
      },
    },
    async ({ title, body, kind, artifact_refs, deps: taskDeps, agent }) => {
      try {
        const authorActor = resolveDeclaredActor(deps, agent);
        if (!authorActor.ok) return fail(new Error(authorActor.message));
        const task = await deps.tasks.create({ title, author: authorActor.name ?? "human", body, kind, artifact_refs, deps: taskDeps });
        deps.onTasksChanged?.({ reason: "task-mutated", id: task.id });
        emitTaskNotification(deps, { type: "created", task, actor: authorActor.name ?? "human" });
        // t-f638bd — the caller wrote the title, body, kind and refs; echoing them back teaches it nothing.
        // What it could not know is the minted id, the lane the store put the task in, the author the
        // Bridge resolved from its token, and the timestamp. That is the whole receipt.
        return ok(JSON.stringify({ id: task.id, status: task.status, author: task.author, createdAt: task.createdAt }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "attach_task_prototype",
    {
      description:
        "Attach one self-contained HTML prototype draft to a Task. Agent-authenticated callers only. " +
        "The Bridge resolves authorship; callers cannot supply lifecycle state, approval, or supersession.",
      inputSchema: {
        id: TASK_ID,
        title: z.string().min(1).max(200),
        html: z.string().min(1).max(512 * 1024),
        mediaType: z.literal("text/html").optional(),
      },
    },
    async ({ id, title, html, mediaType }) => {
      try {
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) throw new Error("attach_task_prototype requires an agent-authenticated caller");
        deps.tasks.get(id);
        const snapshot = new TaskPrototypeStore(deps.workspaceRoot, id).createDraft({ html, title, author: caller.name, mediaType });
        deps.onTasksChanged?.({ reason: "task-mutated", id });
        return ok(JSON.stringify(prototypeBridgeView(snapshot), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_task",
    {
      description:
        "Read one full Task plus derived attention metadata and a bounded window of the materialized " +
        "append-only journal. The persisted task JSON never stores derived metadata or journal entries. " +
        "The journal is capped by BYTES, newest first, and `journalWindow` in every response declares how " +
        "many of how many entries came back — pass journal:\"all\" for the whole log, or page with " +
        "journalOffset.",
      inputSchema: {
        id: TASK_ID.describe("task id from list_tasks or next_task"),
        journal: z
          .enum(["tail", "all", "none"])
          .default("tail")
          .describe(
            "how much journal to materialize: 'tail' (default) the most recent entries that fit the byte cap, " +
              "'all' every entry regardless of size, 'none' just the count. The response always reports the total.",
          ),
        journalOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("with journal:'tail', page FORWARD from this entry index instead of reading the newest; omit for the newest"),
      },
    },
    async ({ id, journal = "tail", journalOffset }) => {
      try {
        // t-ab7708: measured over the harness transcripts, the journal was 66.6% of this tool's cost
        // and 90%+ of its worst calls, entering whole and uncapped every time. It is windowed now, and
        // the window announces itself — truncation that declares itself is not a lie, and the caller
        // reads how to get the rest in the same breath.
        const view = deps.tasks.getView(id, { journalWindow: { mode: journal, offset: journalOffset } });
        const prototypes = new TaskPrototypeStore(deps.workspaceRoot, id).read();
        return ok(JSON.stringify({ ...view, prototypes: prototypeBridgeView(prototypes) }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "submit_evolution_review",
    {
      description:
        "Submit the result of YOUR pending Tachyon Agent Evolution review. The review id comes from " +
        "Tachyon's task-completion notice and is bound to the Bridge-resolved caller. Submit proposals:[] " +
        "when nothing should be retained. Learning and standard Agent Skill proposals remain inert until " +
        "a human approves them in Agent Studio; this tool never changes Soul or Persistent Instructions.",
      inputSchema: {
        review_id: EVOLUTION_REVIEW_ID,
        proposals: z.array(EVOLUTION_PROPOSAL).max(8),
      },
    },
    async ({ review_id, proposals }) => {
      try {
        if (!deps.evolution) throw new Error("Agent Evolution is not available on this Bridge");
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) {
          throw new Error("submit_evolution_review requires an agent-authenticated caller");
        }
        const submission = await deps.evolution.submitReview(
          caller.name,
          review_id,
          proposals as EvolutionCandidateInputTarget[],
        );
        return ok(JSON.stringify({
          review: {
            id: submission.review.id,
            taskId: submission.review.taskId,
            status: submission.review.status,
          },
          candidates: submission.candidates.map((candidate) => ({
            id: candidate.id,
            kind: candidate.target.kind,
            ...(candidate.target.kind === "skill" ? { name: candidate.target.name } : {}),
          })),
          replayed: submission.replayed,
        }, null, 2));
      } catch (error) {
        return fail(error);
      }
    },
  );

  mcp.registerTool(
    "update_task",
    {
      description:
        "Patch a Task. Use expect:{assignee:null} when claiming a task returned by next_task; " +
        "precondition failures are structured errors and mean you must re-query. " +
        "Answers with a compact receipt {id,status,updatedAt,changed,cleared?} — not the task; " +
        "`updatedAt` is the CAS token for your next expect, and `cleared` names fields the STORE " +
        "dropped on its own. Pass include:'task' only if you actually need the whole document back.",
      inputSchema: {
        id: TASK_ID,
        title: z.string().min(1).max(300).optional(),
        body: z.string().max(4000).nullable().optional(),
        status: TASK_STATUS.optional(),
        priority: TASK_PRIORITY.nullable().optional(),
        rank: z.string().min(1).max(64).nullable().optional(),
        kind: z.string().min(1).max(64).nullable().optional(),
        assignee: z.string().min(1).max(64).nullable().optional(),
        artifact_refs: z.array(TASK_ARTIFACT_REF).max(10).nullable().optional(),
        deps: z.array(TASK_ID).nullable().optional(),
        expect: TASK_EXPECT,
        include: z
          .enum(["receipt", "task"])
          .optional()
          .describe("'receipt' (default) answers with {id,status,updatedAt,changed,cleared?}; 'task' echoes the whole task"),
      },
    },
    async ({ id, title, body, status, priority, rank, kind, assignee, artifact_refs, deps: taskDeps, expect, include }) => {
      try {
        const patch = definedPatch({ title, body, status, priority, rank, kind, assignee, artifact_refs, deps: taskDeps, expect });
        const changedFields = Object.keys(patch).filter((key) => key !== "expect");
        if (changedFields.length === 0) {
          throw new Error("update_task requires at least one field");
        }
        // SDD 370: a known AI runtime may be starting, or may have just been
        // rejected and cleaned up. Do not make either state an actionable task
        // assignment. Unknown names remain valid human/external assignees.
        if (assignee && asAgent(deps.manager?.defOf(assignee)) && !(await deps.manager.isReady(assignee))) {
          throw new Error(`cannot assign task to agent '${assignee}' before its runtime is ready`);
        }
        // t-ea86e6 — capture the PRIOR assignee before the mutation so a no-op re-assign doesn't re-notify.
        const priorTask = ("assignee" in patch || "status" in patch) ? deps.tasks.get(id) : undefined;
        const priorAssignee = priorTask?.assignee;
        // t-57a00a / spec 351 — name the agent doing this so the store's sink can tell "someone gave
        // you this" from "you picked up your own". Only an agent caller: a human is never the assignee.
        const callerAgent = deps.caller?.kind === "agent" ? deps.caller.name : undefined;
        const task = await deps.tasks.update(id, callerAgent ? { ...patch, actor: callerAgent } : patch);
        deps.onTasksChanged?.({ reason: "task-mutated", id: task.id });
        const actor = taskNotificationActor(deps);
        if (assignee && assignee !== priorAssignee) {
          emitTaskNotification(deps, { type: "assigned", task, actor, from: priorAssignee, to: assignee });
        }
        if (status && priorTask && status !== priorTask.status) {
          emitTaskNotification(deps, { type: "statusChanged", task, actor, from: priorTask.status, to: status });
        }
        // t-57a00a — the assignee's pane notice is NOT fired here any more. It moved to the store's
        // mutation sink, which every writer crosses; firing it here too would notify twice for a Bridge
        // update and still leave the four UI writers silent. spec 351's self-assign suppression is
        // preserved by the `actor` this handler puts on the patch (see the caller resolution above).
        // t-f638bd — a receipt by default; the whole task only when the caller says it needs it.
        return ok(include === "task" ? JSON.stringify(task) : taskReceipt(priorTask, task, changedFields));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // t-f638bd — the second verb the board was missing. See TaskStore.reconcile for why this is not a
  // relaxation of update_task's transition table.
  mcp.registerTool(
    "reconcile_task",
    {
      description:
        "Record that a Task's work ALREADY finished outside the board — the branch landed, the SHA exists — " +
        "rather than driving it through the lanes. update_task moves work you are doing and demands an " +
        "assignee to reach 'active'; reconciling a finished task through it would mean claiming work that is " +
        "over. This takes triaged/active/landed straight to landed or done, needs no assignee, and requires " +
        "evidence, which is journalled verbatim before the status moves. It does NOT skip triage: an inbox " +
        "task is refused by name, because no SHA answers whether the work was wanted. Answers with a receipt.",
      inputSchema: {
        id: TASK_ID,
        status: z.enum(["landed", "done"]).describe("the outcome that already happened; reconciling never re-opens work"),
        evidence: z
          .string()
          .min(1)
          .max(2000)
          .describe("what makes this true outside the store — a commit SHA, PR, or path; journalled verbatim"),
        expect: TASK_EXPECT,
      },
    },
    async ({ id, status, evidence, expect }) => {
      try {
        const priorTask = deps.tasks.get(id);
        const callerAgent = deps.caller?.kind === "agent" ? deps.caller.name : undefined;
        const task = await deps.tasks.reconcile(id, { status, evidence, ...(expect ? { expect } : {}), ...(callerAgent ? { actor: callerAgent } : {}) });
        deps.onTasksChanged?.({ reason: "task-mutated", id: task.id });
        emitTaskNotification(deps, {
          type: "statusChanged",
          task,
          actor: taskNotificationActor(deps),
          from: priorTask.status,
          to: status,
        });
        return ok(taskReceipt(priorTask, task, ["status"]));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // t-1339a8 — the authored, first-class "blocked on the human" signal (coexists with Validations, a
  // different/shipped-spec-audit workflow). AGENT-ONLY, mirroring request_human_approval's caller check
  // (spec 351): only the coordinator that actually hit a real block can author it — never self-declared
  // by a non-agent caller, and never heuristically derived by the store.
  mcp.registerTool(
    "flag_for_human",
    {
      description:
        "Flag a Task as blocked on the HUMAN — an authored (never derived) signal distinct from the " +
        "Validations subsystem. Sets Task.awaitingHuman (reason, kind, since=now); TaskStore.attentionFor " +
        "then derives an 'awaiting_human' attention from it, so the board highlights the card via the " +
        "existing attention rendering and Mission Control's 'Awaiting you' strip lists it. Any status " +
        "transition on this task clears the flag automatically — a task that advances is no longer " +
        "waiting. Agent-authenticated callers only (mirrors request_human_approval): only the coordinator " +
        "that actually hit the block should author this, never a relayed/self-declared claim.",
      inputSchema: {
        id: TASK_ID,
        reason: z.string().min(1).max(2000).describe("why this task is blocked on the human, shown verbatim on the board"),
        kind: TASK_AWAITING_HUMAN_KIND.describe("what kind of human input is needed: decision | validation | dogfood"),
        subject: z.object({ type: z.literal("task-prototype"), prototypeId: z.string().regex(/^p-[0-9a-f]{12}$/) }).optional()
          .describe("optional exact prototype review subject; approval reconciles only this exact id"),
      },
    },
    async ({ id, reason, kind, subject }) => {
      try {
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) {
          return fail(new Error("flag_for_human requires an agent-authenticated caller (spec 351); legacy/external/human callers cannot flag"));
        }
        if (subject) {
          const prototype = new TaskPrototypeStore(deps.workspaceRoot, id).read().prototypes.find((p) => p.id === subject.prototypeId);
          if (!prototype) throw new Error(`unknown prototype '${subject.prototypeId}'`);
        }
        const task = await deps.tasks.update(id, { awaitingHuman: { reason, kind, since: new Date().toISOString(), ...(subject ? { subject } : {}) } });
        deps.onTasksChanged?.({ reason: "task-mutated", id: task.id });
        emitTaskNotification(deps, { type: "awaitingHuman", task, actor: caller.name, reason, kind });
        // t-f638bd — same receipt as every other task mutation; the flag itself is the caller's own words.
        return ok(taskReceipt(undefined, task, ["awaitingHuman"]));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "clear_human_flag",
    {
      description:
        "Clear a Task's awaitingHuman flag set by flag_for_human — e.g. once the human has responded but " +
        "the coordinator isn't ready to transition the task's status yet. A status transition already " +
        "clears the flag automatically; use this for an explicit clear without one.",
      inputSchema: {
        id: TASK_ID,
      },
    },
    async ({ id }) => {
      try {
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) {
          return fail(new Error("clear_human_flag requires an agent-authenticated caller (spec 351); legacy/external/human callers cannot clear"));
        }
        const task = await deps.tasks.update(id, { awaitingHuman: null });
        deps.onTasksChanged?.({ reason: "task-mutated", id: task.id });
        // t-f638bd — a receipt: the caller asked for one field to go away and needs only the ack and the CAS token.
        return ok(taskReceipt(undefined, task, ["awaitingHuman"]));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // t-35d95a — the authored, first-class "the LIVE conversation needs a human" signal — the
  // counterpart to flag_for_human (t-1339a8), which flags a TASK on the board. A coordinator that
  // ends a turn with a genuine question for the human (not derivable from AttentionState: the CLI
  // just returns to its prompt, indistinguishable from "done, nothing pending") calls this so the
  // human gets an Attention item + sidebar badge instead of silently sitting idle. AGENT-ONLY, mirroring
  // request_human_approval/flag_for_human (spec 351): only the agent itself can author this about
  // itself — there is no `agent` param, the target is always the Bridge-resolved caller. Cleared
  // automatically the moment the agent's pane next shows real output (the human having responded).
  // OS/mobile push is OUT OF SCOPE (deferred to the companion t-fe52f0/t-619157) — this is in-app
  // Attention Stack + badge only.
  mcp.registerTool(
    "request_human_attention",
    {
      description:
        "Latch an awaiting-human signal on YOUR OWN live session — call this when you end a turn genuinely " +
        "needing the human (e.g. a design question), not when you're merely idle waiting on other agents in " +
        "flight. Adds an item to the Tachyon Attention Stack + sidebar badge with your one-line reason; clears automatically the " +
        "moment you next produce real output (the human responding IS the clear condition — no explicit " +
        "clear call needed). There is no `agent` param — the target is always the Bridge-resolved caller, " +
        "agent-authenticated only (mirrors request_human_approval/flag_for_human, spec 351); legacy/external/" +
        "human callers cannot self-declare this for someone else. Distinct from flag_for_human, which flags a " +
        "Task on the board, not your live pane. Not for a real authorization decision — use " +
        "request_human_approval for that.",
      inputSchema: {
        reason: z.string().min(1).max(500).describe("one-line reason shown verbatim in the toast + sidebar badge"),
      },
    },
    async ({ reason }) => {
      try {
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) {
          return fail(new Error("request_human_attention requires an agent-authenticated caller (spec 351); legacy/external/human callers cannot request attention"));
        }
        deps.flagAwaitingHuman?.(caller.name, reason);
        return ok(JSON.stringify({ agent: caller.name, reason }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "append_task_note",
    {
      description:
        "Append a task-local execution note to a Task's journal. Use ONLY for annotations about a task in progress " +
        "(blockers, decisions, deviations, handoff context). Do not use for follow-up work; create_task for that. " +
        "Do not use for human reminders or cross-cutting findings; create_pin for those. Author is always the Bridge-resolved caller; never pass author. " +
        "Answers with a receipt {taskId,entryId,ts,author} — your own note text is not echoed back.",
      inputSchema: {
        id: TASK_ID.describe("task id from list_tasks or next_task"),
        text: z.string().min(1).max(4000).describe("journal text; bounded per entry and appended atomically to the per-task .journal log"),
        author: z.string().optional().describe("reserved legacy field; rejected when supplied because authorship is Bridge-resolved"),
      },
    },
    async ({ id, text, author }) => {
      try {
        if (author !== undefined) throw new Error("INVALID_ARGUMENT: append_task_note does not accept author; authorship is Bridge-resolved");
        const task = deps.tasks.get(id);
        const resolvedAuthor = resolvedJournalAuthor(deps);
        const entry = deps.tasks.journal.append(id, { author: resolvedAuthor, text });
        deps.onTasksChanged?.({ reason: "journal-appended", id });
        if (task.status === "active") emitTaskNotification(deps, { type: "journalAppended", task, actor: resolvedAuthor });
        await notifyTaskJournalAppended(deps, task, resolvedAuthor);
        // t-f638bd — the entry's `text` is the caller's own argument coming straight back; at 99 measured
        // calls that echo cost ~101k tokens to confirm writes the caller had just composed. The receipt
        // keeps what it did not supply: the minted entry id, the timestamp, and the Bridge-resolved author.
        return ok(JSON.stringify({ taskId: id, entryId: entry.id, ts: entry.ts, author: entry.author }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_tasks",
    {
      description:
        "List bounded Task summaries for Mission Control. Omits body by default; use get_task for one full task. " +
        "Surfaces actionable work first (active > triaged > inbox > landed > done > dropped) so the default " +
        "cap never silently truncates the queue an orchestrator needs; pass status to filter to one lane.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0).describe("number of matching tasks to skip before returning this page"),
        status: TASK_STATUS.optional().describe(
          "filter to a single status (inbox|triaged|active|landed|done|dropped); omit to list all, sorted actionable-first",
        ),
      },
    },
    async ({ limit = 100, offset = 0, status }) => {
      try {
        // t-3fb7d1: the store orders before slicing and accepts an offset, so tasks past the 500-read cap
        // are reachable through pagination instead of being walled off behind the first page.
        const page = deps.tasks.listViews(limit, { offset, status });
        const matchingTotal = deps.tasks.count({ status });
        const ordered = orderTaskViewsForListing(page, status);
        const sliced = ordered.slice(0, limit);
        const json = JSON.stringify(sliced.map(taskSummary), null, 2);
        const notes: string[] = [];
        const nextOffset = offset + sliced.length;
        if (matchingTotal > nextOffset) {
          notes.push(
            `note: showing ${sliced.length} of ${matchingTotal} matching tasks (offset=${offset}, limit=${limit}); ` +
              `request offset=${nextOffset} to see the next page.`,
          );
        }
        if (offset > 0 && sliced.length === 0) {
          notes.push(
            `note: offset ${offset} is beyond the ${matchingTotal} matching tasks; request a lower offset to page results.`,
          );
        }
        if (notes.length) {
          return { content: [{ type: "text" as const, text: json }, ...notes.map((text) => ({ type: "text" as const, text }))] };
        }
        return ok(json);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "next_task",
    {
      description:
        "Return the single best Task for an assignee to work next. Advisory only: claim unassigned work with " +
        "update_task(id, assignee:<you>, expect:{assignee:null}) before editing.",
      inputSchema: {
        agent: z.string().min(1).max(64).describe("assignee asking for work; use 'human' for the human queue"),
      },
    },
    async ({ agent }) => {
      try {
        return ok(JSON.stringify(deps.tasks.next(agent), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
