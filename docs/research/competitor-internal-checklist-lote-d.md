# Lote D — runtime internal checklist and plan governance

**Task:** `t-e04ae4` (lote of `t-213110`)
**Measured:** 2026-08-16
**Scope:** synara, t3-code, warp
**Method:** shallow clone outside the Tachyon tree; source lines only. README marketing is not a finding.

No Tachyon design is proposed here.

## Repos read

| Competitor | License | Clone | HEAD | Commit date |
|---|---|---|---|---|
| synara | MIT | `github.com/Emanuele-web04/synara` | `18ff99857d5b84adab2019c2839fa4f6df761b7c` | 2026-08-15 00:57:44 +0200 |
| t3-code | MIT | `github.com/pingdotgg/t3code` | `bab4b6f02b8bdaf15fd32636a97f69ff657cec50` | 2026-08-16 18:25:43 +0530 |
| warp | AGPL-3.0 (client) | `github.com/warpdotdev/warp` | `19dc50535dc8513ffe306e6c965c58b876374a1a` | 2026-08-16 03:22:07 -0500 |

Synara's own README states it began as a clone of T3 Code. The two trees still share the same adapter/event shape. They are measured separately because the wiring has already diverged.

## Negative control

Invented names `checklistTelemetryXyz` and `requirePlanAbsurd` were grepped in each clone (including tests, docs, generated schema). All three searches returned empty (`rg` exit 1). Declared here so a later name-similarity hit is not this probe.

## Observation vs governance (read this first)

The umbrella asks two different things:

1. **Observation** — does the product *read* the runtime's native internal checklist (`TodoWrite` / `TaskCreate` / `update_plan` / `todo_write` / `todo.updated` / ACP `sessionUpdate: "plan"`).
2. **Governance** — does the product *require* a plan on every task (prompt that always plans, mandatory tool, gate that refuses a turn without a plan, retry when none arrived).

Plan Mode (a user-toggled collaboration mode that produces a `<proposed_plan>` document) is not the same object as the runtime internal checklist. Both products that have Plan Mode say so in source: Codex `update_plan` "is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode."

## Roster verdict

| Competitor | Lê checklist nativo? | Inventou o próprio (execução)? | Exige plano em toda tarefa? |
|---|---|---|---|
| synara | Yes — multi-runtime, flattened to `turn.tasks.updated` | No competing execution checklist. Proposed-plan is a different surface. | **No.** Plan mode is an optional toggle. |
| t3-code | Yes — Claude, Codex, Grok, Cursor. **Not** OpenCode `todowrite`. Flattened to `turn.plan.updated` | No competing execution checklist. In-memory progress is a view of the native event. | **No.** Plan mode is optional and can be switched off. |
| warp (open client) | **Not found** in the AGPL tree. No `TodoWrite` / `update_plan` / `todo_write` / `turn/plan/updated` reader. | Yes — own MAA task-list proto + plan-as-notebook artifact. | **Not found** as a gate in the open client. `/plan` is opt-in. Closed orchestration is unmeasured. |

---

## synara

### Lê checklist nativo?

Yes. Synara watches the native channel of each wired runtime and collapses it onto one product event, `turn.tasks.updated`, whose payload is `{ task, status }` with `status ∈ pending | inProgress | completed`.

| Runtime | Channel | File:line |
|---|---|---|
| Claude Code | `TodoWrite` tool input `{ todos: [{ content, status, activeForm }] }` | `apps/server/src/provider/claudeTaskTracker.ts:163–185` (`normalizeClaudeTodoTasks`); emitted at `apps/server/src/provider/Layers/ClaudeAdapter.ts:2435–2474` and `:3057–3063` |
| Claude Code | `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` results (item ids, `subject`, `blockedBy`, `activeForm`) | `apps/server/src/provider/claudeTaskTracker.ts:187–326`; payload via `claudeTrackedTasksPayload` at `:315–326` |
| Codex | app-server notification `turn/plan/updated` | `apps/server/src/provider/Layers/CodexAdapter.ts:1214–1236` |
| Grok (ACP) | `session/update` with `sessionUpdate: "plan"` | parse at `apps/server/src/provider/acp/AcpRuntimeModel.ts:587–601`; emit at `apps/server/src/provider/Layers/GrokAdapter.ts:733–758` |
| Cursor (ACP) | `cursor/update_todos` | `apps/server/src/provider/acp/CursorAcpExtension.ts:80–96` |
| OpenCode | event `todo.updated` | `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1114` (ingress) and `:2675–2689` (emit) |
| Droid (ACP) | same ACP `makeAcpPlanUpdatedEvent` as Grok/Cursor | `apps/server/src/provider/Layers/DroidAdapter.ts` (imports at `:95`, emit at `:476`) |
| Pi | **not found.** Adapter comment: Synara does not add plan-mode semantics on top of Pi | `apps/server/src/provider/Services/PiAdapter.ts:3–5` |

Status spelling is reconciled at `apps/server/src/provider/runtimeTaskList.ts:3–11` (`in_progress` and `inProgress` both become `inProgress`). Empty lists are dropped (`nonEmptyRuntimeTaskListPayload`, `:30–33`).

### Inventou o próprio?

**No competing execution checklist.** Synara does not inject a Synara-owned `todo` tool. The execution list the UI shows is the latest native snapshot.

Two other surfaces exist and must not be counted as a second runtime checklist:

- **Proposed plan** (`<proposed_plan>…</proposed_plan>` markdown, persisted as `ProjectionThreadProposedPlans`). This is Plan Mode's deliverable, extracted by `apps/server/src/provider/planMode.ts:36–39` and implemented via `apps/web/src/proposedPlan.ts:73–93`. The Codex instructions in `apps/server/src/codexAppServerManager.ts:448–452` say this is *not* `update_plan`.
- **Environment / kanban / work-log checklists** are product UI (pins, board cards). They do not subscribe to `TodoWrite` / `turn/plan/updated`.

If Claude emits both `TodoWrite` and `TaskCreate` in one turn, both become `turn.tasks.updated`. The UI keeps the last non-empty snapshot of the current turn (`apps/web/src/session-logic.ts:242–258`). That is two *native* channels on one slot, not Synara inventing a third list.

### Exige plano?

**No.** Absence of a require-plan gate is the result.

Plan mode is a per-thread `interactionMode: "plan" | "default"` the user toggles. The prompt shim at `apps/server/src/provider/planMode.ts:11–34` is prepended **only** when `interactionMode === "plan"`. Default mode does not receive it.

When plan mode *is* on, Synara governs the *mode*, not the checklist:

- Codex: native collaboration mode `plan` plus developer instructions (`apps/server/src/codexAppServerManager.ts:754–783`). `update_plan` is explicitly forbidden inside Plan Mode (`:448–452`).
- Claude: tagged `<proposed_plan>` is extracted only while `interactionMode === "plan"` (`ClaudeAdapter.ts:3612–3623`). `ExitPlanMode` is a separate native door (`:3596–3609`).
- Grok: `_meta.mode` is set to `"plan"` or `"agent"` (`GrokAdapter.ts:256–262`). A `PreToolUse` hook named `synara-plan-guard` **denies mutating tools** while in plan mode (`GrokAdapter.ts:230–239`, `:277–300`). `todo_write` is on the allow-list (`:224`) — the hook permits the native checklist, it does not require it.
- OpenCode: plan mode selects the plan agent (`OpenCodeAdapter.ts:3915`).
- Pi: no plan-mode overlay (`PiAdapter.ts:3–5`).

No source was found that refuses a default-mode turn because `TodoWrite` / `update_plan` / `todo_write` did not fire, or that retries until a plan arrives.

### Multi-runtime?

Canonical item is `{ task: string, status: pending|inProgress|completed }` (`runtimeTaskList.ts:13–27`). Every adapter above writes `turn.tasks.updated`. The composer card (`ActiveTaskListCard.tsx:59–76`) renders that list. There is no per-runtime schema left in the UI.

Cost of that flatten: Claude's item ids, owners, and `blockedBy` edges die at `claudeTrackedTasksPayload` (`claudeTaskTracker.ts:315–326`). Codex step order survives as array order; Codex has no stable per-step id in the event Synara keeps.

### Runtime mudo?

Hides. Does not invent an empty list.

- Adapter: empty input → `null` (`runtimeTaskList.ts:30–33`; OpenCode `:2676–2678` `break`s; ACP plan with `plan.length === 0` is not pushed, `AcpRuntimeModel.ts:592`).
- UI: a snapshot with `tasks.length === 0` returns `null` (`session-logic.ts:258`, `:271–273`). An all-completed list from a prior turn is also dropped (`:275–277`). Comment at `:261–263` says the last *unfinished* list stays visible across turn boundaries until the provider completes every task **or sends an explicit empty snapshot**. Missing events are not treated as "empty, all done."

---

## t3-code

### Lê checklist nativo?

Yes, on Claude, Codex, Grok, and Cursor. The product event is `turn.plan.updated` with `{ step, status }`, not Synara's later `turn.tasks.updated`.

| Runtime | Channel | File:line |
|---|---|---|
| Claude Code | `TodoWrite` (name match is `toLowerCase().includes("todowrite")`) | `apps/server/src/provider/Layers/ClaudeAdapter.ts:765–793`, emit `:2571–2592` |
| Claude Code | `TaskCreate` / `TaskUpdate` / `TaskList` | detect `:796–798`; apply `:833–917`; emit as `turn.plan.updated` with `explanation: "Claude Tasks"` at `:2166–2198` |
| Codex | `turn/plan/updated` | `apps/server/src/provider/Layers/CodexAdapter.ts:1068–1086` |
| Grok (ACP) | `makeAcpPlanUpdatedEvent` → `turn.plan.updated` | `apps/server/src/provider/Layers/GrokAdapter.ts:465–495`; factory `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:135–158` |
| Cursor (ACP) | `cursor/update_todos` | `apps/server/src/provider/acp/CursorAcpExtension.ts:85–113` |
| OpenCode | **not found.** `todowrite` / `todo.updated` do not appear in `OpenCodeAdapter.ts` or `opencodeRuntime.ts`. Plan mode only selects the OpenCode `"plan"` agent | `OpenCodeAdapter.ts:1479` |
| Pi | **not found.** No Pi adapter in this tree | — |

In-memory `ThreadPlanProgressService` (`apps/server/src/orchestration/ThreadPlanProgress.ts:1–13`, `:45–73`) is a working-indicator view of the same `turn.plan.updated` payload. It is not a second store: "no persistence, no migration"; all-completed plans are deleted.

### Inventou o próprio?

**No competing execution checklist.** Same ancestry as Synara: the list the UI shows is the native snapshot, renamed.

Proposed-plan (`apps/web/src/proposedPlan.ts:73–93`) and Codex developer instructions (`apps/server/src/provider/CodexDeveloperInstructions.ts:24–28`) are Plan Mode, not a T3-owned todo tool.

`TaskCreate` and `TodoWrite` both write `turn.plan.updated`. Last snapshot of the turn wins (`apps/web/src/session-logic.ts:582–599`). Two native Claude channels, one chip.

### Exige plano?

**No.**

Plan mode is optional and, in this tree, behind a beta flag. With `settings.planModeEnabled` off, the effective mode is forced to `"default"` even if the thread stored `"plan"` (`apps/web/src/components/ChatView.tsx:1548–1555`).

When the flag is on and the user chooses plan:

- Codex gets `CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS` (`CodexDeveloperInstructions.ts:14–143`, selected at `:169–176`). Default mode tells the model the previous Plan Mode instructions are no longer active and to prefer executing (`:146–157`).
- Claude maps `interactionMode === "plan"` onto the SDK permission mode `"plan"` (`ClaudeAdapter.ts:4396–4410`).
- Cursor maps app plan mode onto ACP session mode (`CursorAdapter.ts:227`).
- OpenCode sets `activeAgent` to `"plan"` (`OpenCodeAdapter.ts:1479`).

No source was found that refuses a default-mode turn without a plan, or that retries until `update_plan` / `TodoWrite` arrives. Default-mode Codex instructions are the opposite: "strongly prefer making reasonable assumptions and executing."

### Multi-runtime?

Canonical event is `turn.plan.updated`. UI derives `ActivePlanState` from the latest such activity (`session-logic.ts:582–599`) and one inline chip per turn (`deriveTurnPlans`, `:616–643`). OpenCode's native `todowrite` is the hole: that runtime can have a checklist Synara would show and T3 will not.

### Runtime mudo?

Hides.

- `extractPlanStepsFromTodoInput` returns `null` for a missing/empty `todos` array (`ClaudeAdapter.ts:774–778`).
- `emitClaudeTaskPlanUpdated` returns if `plan.length === 0` (`:2173–2176`).
- `deriveTurnPlans` **deletes** the turn's chip when a later snapshot has no steps (`session-logic.ts:627–631`): "keeping the stale entry would freeze the chip on a withdrawn plan."
- `ThreadPlanProgress.recordPlanProgress` deletes the entry when every step is completed or the plan is empty (`ThreadPlanProgress.ts:57–59`).

Missing events are not rendered as an empty checklist.

---

## warp

**Scope limit (do not over-read).** This repository is the AGPL client. Warp's own README (`README.md:56–62`) says the UI crates are MIT and "the rest of the code in this repository" is AGPL; the same README (`:34`) says the product is a built-in coding agent **or** a bring-your-own CLI agent (Claude Code, Codex, Gemini CLI). GraphQL exposes harnesses `CLAUDE_CODE | CODEX | GEMINI | OZ` (`crates/warp_graphql_schema/api/schema.graphql:262–266`). Orchestration and the cloud side are not in this tree. **Absence of a plan-require gate here is not absence in the product.**

### Lê checklist nativo?

**Not found** in the open client.

`rg` over the tree (excluding `specs/` and bundled skills) for `TodoWrite`, `todo_write`, `todowrite`, `update_plan` (the Codex tool), `TaskCreate`, `TodosUpdated`, `turn/plan/updated` hits only:

- `update_plan_notebook_uid` — a *method that writes a notebook id onto a plan artifact*, not Codex `update_plan` (`app/src/ai/agent/conversation.rs:1698–1727`).
- GraphQL `lastTaskCreated` — ambient-agent bookkeeping, not Claude `TaskCreate`.
- Markdown/editor task-list rendering (`crates/editor/src/render/element/task_list.rs`, `crates/markdown_parser`).

No adapter maps Claude `TodoWrite`, Codex `turn/plan/updated`, or Grok `todo_write` into the client model. Local harness setup for Claude/Codex (`app/src/ai/local_harness_setup.rs`) checks whether the CLI is installed; it does not subscribe to those checklist channels.

If Warp's built-in agent or the closed orchestrator reads those natives, that code is not in this clone.

### Inventou o próprio?

**Yes — a Warp-owned task list, not a runtime checklist reader.**

- Shared conversations carry `finalTaskList: String!` described as "Base64-encoded proto binary of the final task list" and `hasTaskList` described as "True if there's a Warp MAA task list available" (`crates/warp_graphql_schema/api/schema.graphql:53–55`, `:78–79`).
- The client decodes that proto into `ConversationData` (`app/src/server/server_api/ai.rs:2336–2341`) and loads `task_list.tasks` into the conversation (`app/src/terminal/view/load_ai_conversation.rs:1154–1171`).
- TUI renders that list (`crates/warp_tui/src/agent_block_tests.rs:2089+`).
- Restoring a conversation with an empty Warp task list is an error in the YAML materializer (`app/src/ai/agent/conversation_yaml_tests.rs:297–300`, `"No root task found"`). That invariant is about *their* task tree, not about a mute Claude/Codex checklist.

Separately, Plan Mode produces a **plan artifact** (a notebook document), not a checklist:

- `PlanArtifact` → `Artifact::Plan { document_uid, notebook_uid, title }` (`app/src/ai/artifacts/mod.rs:221–235`).
- `update_plan_notebook_uid` binds that document to Warp Drive (`conversation.rs:1698–1727`).
- UI has an "update plan" button on the AI document view (`app/src/ai/ai_document_view.rs:159`, `:416`).

Whether the closed orchestrator also writes a checklist the model must keep updated is **not found** in this repo.

### Exige plano?

**Not found as a client-side gate. Do not conclude the product never requires one.**

What the open tree does show:

- `UserQueryMode` default is `Normal`. `/plan` and `/orchestrate` are prefix commands (`app/src/ai/agent/mod.rs:2637–2651`). A query without the prefix stays `Normal`.
- The tip text is opt-in: `` `/plan` <prompt> to create a plan for the agent before executing. `` (`app/src/ai/agent_tips.rs:104`).
- No source was found that refuses to send a `Normal` query because a plan artifact or MAA task list is missing.
- A predict-path comment says a complex task "should use Dispatch to create a plan first" (`app/src/ai/predict/generate_am_query_suggestions/api/response.rs:31`). That is a suggestion comment, not a turn gate.

If Oz / the cloud agent always seeds a root task or always enters plan internally, that policy would live in the closed side. The client will render a `finalTaskList` it is given; it does not, in this tree, demand one before the first turn.

### Multi-runtime?

The client names four harnesses (`CLAUDE_CODE`, `CODEX`, `GEMINI`, `OZ`). The open tree has no per-runtime checklist normalizer, so there is no measured reconciliation of Claude vs Codex vs Grok formats. BYO CLI agents are a product claim (`README.md:34`); their native checklists are not ingested here.

### Runtime mudo?

Not applicable to native runtime checklists: the reader is not in this tree.

For Warp's own list: an empty proto/YAML task list fails restore (`conversation_yaml_tests.rs:297–300`). That is "our store has no root task," not "Claude did not emit `TodoWrite`." How the live agent UI behaves when the cloud sends no `finalTaskList` on a new conversation was not established from this clone (the field is non-null in GraphQL, so the server always sends a string — contents unmeasured).

---

## Who requires a plan?

None of the three, on the evidence in these clones, govern the runtime so that **every** task must have an internal plan/checklist.

| Product | Optional Plan Mode? | Mandatory internal checklist? |
|---|---|---|
| synara | Yes (user toggle; prompt + permission/hook overlays) | No |
| t3-code | Yes (user toggle; can be compiled out via `planModeEnabled`) | No |
| warp (open client) | Yes (`/plan` prefix) | Not found. Closed side unmeasured. |

Who only *shows* the checklist when the runtime emits it: synara (all wired runtimes including OpenCode) and t3-code (Claude, Codex, Grok, Cursor; not OpenCode). Warp's open client shows Warp's own task list when the cloud sends `finalTaskList`; it does not show Claude/Codex/Grok native checklists.

## What this lote does not answer

- Live behavior of Warp Oz / cloud orchestration (not in the AGPL client).
- Whether a mute Grok `todo_write` still writes `plan.json` on disk that neither ADE reads — out of scope; this pass is ADE source, not a runtime remeasure (`docs/research/runtime-internal-checklist-capabilities.md` already covers the runtimes).
- Synara vs T3 product quality. The interesting delta is one wiring hole: OpenCode `todo.updated` is connected in Synara and absent in T3.
