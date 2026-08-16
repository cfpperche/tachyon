# Lote B — herdr, hive, kandev: checklist interno e governança de plano

**Task:** `t-5af987` (lote de `t-213110`) · **Measured:** 2026-08-16 · **Scope:** source of three open-source multi-agent orchestrators, read at the commits below. No model call. Cost: USD 0.00.

This lote answers the owner's two questions, in that order:

1. How does each competitor treat the runtime's **internal checklist** — read the native one, invent its own, or ignore it?
2. Does it **govern the runtime to require** an internal plan on every task?

Observation and governance are kept separate. A prompt that says "please plan" is not a gate. Marketing copy is not a finding. Absence measured is a result.

The three products all host guest CLIs (Claude Code, Codex, Grok, and others). The expensive question here is **reconciliation**: if a product supports Claude and Codex at the same time, how does it handle the two plan formats being incompatible?

## Repos read

Shallow clones in `/tmp/compB-competitors/` (outside the Tachyon tree). No third-party code was copied into this repository.

| Product | License on this tree | Default branch | Commit | Commit date | Subject |
|---|---|---|---|---|---|
| [herdr](https://github.com/ogulcancelik/herdr) | Apache-2.0 (`Cargo.toml` `license = "Apache-2.0"`; `CHANGELOG.md:27` records the relicensing from AGPL-3.0-or-later). The 2026-07-21 roster card still says AGPL-3.0. | `master` | `51b7064ef0a02642393bab1d2eea0f4dbd8414d2` | 2026-08-16T01:11:09+03:00 | fix: keep agent skill aligned with stable releases |
| [hive](https://github.com/tt-a1i/hive) | BUSL-1.1 (`LICENSE.BSL`, Change Date 2030-05-16) | `main` | `1096789b17cc8215869616d21aa6e76cd139eb19` | 2026-06-18T14:39:57+08:00 | Improve public README positioning (#32) |
| [kandev](https://github.com/kdlbs/kandev) | AGPL-3.0 (`LICENSE`) | `main` | `8d006c40115fcec19196458d824d1a8d345e6d26` | 2026-08-16T15:40:11+01:00 | fix(web): open review panes in selected split (#2710) |

Runtime native surfaces used as the comparison baseline (not remeasured here): `docs/research/runtime-internal-checklist-capabilities.md` (remeasured 2026-08-16 for Claude `TaskCreate`/`TodoWrite`, Codex `update_plan` + `turn/plan/updated`, Grok `todo_write` + `plan.json` + `TodosUpdated`).

## Negative control

Invented names must be absent. Grep on each clone, 2026-08-16:

```text
rg -n "checklistTelemetryXyz|requirePlanAbsurd" /tmp/compB-competitors/{herdr,hive,kandev}
```

Result: **empty in all three repositories.**

Positive-absence probes on the native runtime names (so "does not read native" is not a silent miss of a different spelling):

```text
rg -n "TodoWrite|TaskCreate|update_plan|todo_write|TodosUpdated|turn/plan/updated|todowrite" \
  /tmp/compB-competitors/herdr --glob '!vendor/**' --glob '!website/**'
# empty

rg -n "TodoWrite|TaskCreate|update_plan|todo_write|TodosUpdated|turn/plan/updated|todowrite" \
  /tmp/compB-competitors/hive/src /tmp/compB-competitors/hive/web
# empty
```

Kandev *does* contain `TaskCreate` / `TaskUpdate` / `TaskGet` — those are **Kandev's own board/CLI verbs**, not Claude's tools. The mock-agent helper comments `TodoWrite` (`apps/backend/cmd/mock-agent/sequences.go:164`). The native vendor strings `update_plan`, `todo_write`, `TodosUpdated`, `turn/plan/updated` were **not found** as ingest channels. See the kandev ficha.

## Who requires a plan vs who only shows one

| Product | Reads native runtime checklist? | Invented its own? | Governs the runtime to *require* a plan? |
|---|---|---|---|
| herdr | **No.** Not found. Screen-detects "plan mode" chrome as idle/blocked/working. | **No.** Not found. | **Does not require.** |
| hive | **No.** Session-home readers exist only to capture **session IDs** for resume. | **Yes.** `.hive/tasks.md` GFM checklist, plus a prompt that asks the orchestrator to maintain it. | **Does not require.** Empty file is valid. `team send` does not consult the file. The drawer is marked dormant. |
| kandev | **Yes, on the ACP path.** `session/update` `Plan` and a fallback that scrapes todo-tool `RawOutput`. Does **not** read `~/.claude/tasks/`, Codex app-server `turn/plan/updated`, or Grok `plan.json` / `TodosUpdated`. | **Yes.** Durable markdown `TaskPlan` via MCP (`create_task_plan_kandev` / `get_task_plan_kandev` / `update_task_plan_kandev`), plus a display store for session todos. | **Does not require.** Plan mode is an optional prompt + session metadata flag. No gate refuses a turn without a plan. Passthrough sessions do not even have the MCP plan contract. |

Two checklists competing is a finding, and it only happens in kandev (and, weakly, in hive's dormant file vs the guest CLI's own unread list).

---

## herdr

Multiplexer / PTY host. Guest CLIs include Claude, Codex, Grok, OpenCode, Pi, Hermes, and others. Detection manifests plus lifecycle hooks give semantic agent state (`idle` / `working` / `blocked`). There is no task board and no plan store.

### Lê checklist nativo?

**Não encontrado.**

Searched `src/` (Rust + TOML manifests) for `TodoWrite`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `update_plan`, `todo_write`, `TodosUpdated`, `turn/plan/updated`, `todowrite`, `todo.updated`, `TodoStore`, `plan.json`, `~/.claude/tasks`. Empty.

What *plan* does appear is not a checklist:

- `src/agent_resume.rs:22` `AgentResumePlan` and `src/agent_resume.rs:118` `plan(...)` build the **resume argv** (`codex resume <id>`, `copilot --resume=...`). That is session identity, not an execution checklist.
- Detection manifests treat the word "plan" as **UI chrome for agent state**:
  - `src/detect/manifests/cline.toml:16-17` — `[plan mode]` + `execute command?` / `use this tool?` → `state = "blocked"`.
  - `src/detect/manifests/claude.toml:143` — `skip interview and plan immediately` is one of the `legacy_no_prompt_blocker` needles (permission/interview overlay, not a todo list).
  - `src/detect/manifests/maki.toml:27-35` — `plan complete` / `edit plan` form is a **blocked** state (`plan_complete_form`).
  - `src/detect/manifests/kimi.toml:19` — `ready to build with this plan?` as a blocker needle.
- Lifecycle hooks (`src/integration/assets/claude/herdr-agent-state.sh`) consume Claude hook JSON for `session_id` / `transcript_path` / working-vs-idle. The script exits unless `action` is `session` (lines 15–18). It does not parse todos, `TaskCreate`, or `~/.claude/tasks`.
- `src/api/` has no method whose name or schema mentions todo, checklist, or plan.

Channel: **none**. Herdr watches the screen and the hook stream for *whether the agent is blocked*, not *what the agent listed*.

### Inventou o próprio?

**Não encontrado.** No `.herdr/tasks`, no product todo table, no MCP plan tool, no in-memory checklist type beyond resume/install "plans" named in ordinary English.

If the guest runtime also has a checklist, Herdr does not read it and does not replace it. The two never meet in this tree.

### Exige plano?

**Não exige.**

No prompt that mandates planning, no required tool, no gate that refuses a turn without a plan, no retry when a plan did not arrive. The public skill (`skills/herdr`) has no plan/todo/checklist text.

`CHANGELOG.md` mentions "Codex Plan mode question prompts" only as a **state-detection** fix (stale `working` vs waiting-for-answer). That is observation of chrome, not governance of a checklist.

### Multi-runtime?

Herdr hosts many CLIs in one process and **does not reconcile plan formats**, because it never ingests a plan. Codex and Claude can run in adjacent panes; each keeps its own unread native list.

### Runtime mudo?

Not applicable as a checklist path. A runtime that emits no plan does not change Herdr's state machine. Herdr will still classify idle/working/blocked from OSC titles, screen regions, and hooks. It does not invent an empty checklist and does not claim the list is empty.

---

## hive

Local browser workbench. One orchestrator CLI plus worker CLIs (Claude, Codex, Gemini, OpenCode, and others). Inter-agent traffic is a `team` binary (`team send` / `team report` / `team status`). Hive itself is not a coding loop.

### Lê checklist nativo?

**Não encontrado.**

`src/server/session-capture.ts` plus `session-capture-claude.ts` / `session-capture-codex.ts` / `session-capture-gemini.ts` / `session-capture-opencode.ts` read guest homes **only to discover session IDs** for resume:

- Claude: list `~/.claude/projects/<encoded_cwd>/*.jsonl` UUIDs (`session-capture-claude.ts:10-39`). File bodies are opened only when a discriminator `contentIncludes` is set (`session-capture-claude.ts:51-66`) — still a session-identity match, not a todo parse.
- Codex: walk `~/.codex/sessions/**/rollout-*.jsonl` and parse the **first line** for `payload.id` + `payload.cwd` (`session-capture-codex.ts:78-101`). The rest of the rollout, including any `update_plan` / plan item, is not read.
- Gemini / OpenCode: same ID-only pattern.

There is no ACP client, no `session/update` handler, no `turn/plan/updated` subscriber, no `plan.json` reader, no `TodosUpdated` handler. Native names listed in the negative-control probe are absent from `src/` and `web/`.

The `TaskCreate` hits under `vendor/marketplace/**` are FreeRTOS examples in a role-template markdown file, not product code.

### Inventou o próprio?

**Sim.** `.hive/tasks.md` is a repo-local GFM checklist.

- Persistence: `src/server/tasks-file.ts:11-15` (`HIVE_DIR_NAME = '.hive'`, `TASKS_FILE_NAME = 'tasks.md'`). `ensureTasksFile` (`tasks-file.ts:29-40`) creates the file if missing (empty string, or migrates a legacy root `TASKS.md`). HTTP `GET`/`PUT /api/workspaces/:id/tasks` (`src/server/routes-tasks.ts:7-46`) read and write that file. A watcher (`tasks-file-watcher.ts`) keeps the UI in sync.
- Model: `web/src/tasks/task-markdown.ts:10` `TASK_LINE = /^(\s*)-\s+\[( |x|X)\]\s+(.*)$/` — checkbox, indent, optional `@worker` mentions. Comment at `task-markdown.ts:188` calls it "in practice a pure GFM checklist".
- Prompt: orchestrator startup (`src/server/agent-startup-instructions.ts:41-46`) says the role is to clarify, break work down, and **maintain** `${TASKS_RELATIVE_PATH}`. `hive-team-guidance.ts:83` (written into `.hive/PROTOCOL.md`) says the Orchestrator "plans tasks, dispatches to workers".
- UI: topbar "Tasks (.hive/tasks.md)" (`web/src/i18n.tsx:184-187`). `WorkspaceTaskDrawer.tsx:34-38` states the current product stance in source: early Hive treated the file as a first-class planning surface; **current usage relies on the Orchestrator agent's own planning**; the adapter is kept wired "for existing workspaces and future revival."

If the guest runtime also has a checklist, Hive does not read it. The invented file and the native list can both exist. Hive never merges them. The drawer comment is the product admitting the invented list is no longer the planning authority.

### Exige plano?

**Não exige.**

- `ensureTasksFile` accepts and persists an **empty** file (`tasks-file.ts:37-38`).
- `src/cli/team.ts:23` `team send <worker-name> "<task>"` takes a free-form string. There is no lookup against `.hive/tasks.md`, no "open task required" check, no refusal if the file is empty.
- Orchestrator reminder tail (`hive-team-guidance.ts:18-21`) requires `team send` / `team cancel` / plain text — not a plan tool.
- No retry when a guest CLI fails to emit `update_plan` / `TodoWrite`. Hive never asked.

"Plans tasks" in the protocol doc is role prose. The code path that would make planning mandatory is not there.

### Multi-runtime?

Hive launches heterogeneous CLIs and talks to them through PTY stdin plus the `team` CLI. Session-ID capture is per-runtime (different homes, different file shapes) and **stops at the id**. There is no plan-format adapter, so there is nothing to reconcile. Claude's `TaskCreate` DAG and Codex's `update_plan` array can both exist on disk; Hive does not see either.

### Runtime mudo?

A guest that never writes a native checklist is invisible as a checklist. Hive does not fabricate native items. The invented `.hive/tasks.md` may be empty; the UI still opens. That empty file is Hive's own store, not a claim about the runtime.

---

## kandev

Self-hosted kanban + ACP control plane. Guest agents include Claude, Codex, Grok, OpenCode, Copilot, Gemini, Cursor, Amp, Pi, and a **passthrough** TUI path. This is the only product in the lote that actually *reads* a runtime plan.

Kandev keeps **several** plan-shaped objects. They are not the same thing:

| Object | What it is | Store | Who writes it |
|---|---|---|---|
| Session todos (`EventTypePlan` / `session.todos_updated`) | Flattened execution checklist | Live WS store + persisted `MessageTypeTodo` chat message | ACP `session/update` `Plan`, or todo-tool `RawOutput` |
| `MessageTypeAgentPlan` | Markdown blob from ExitPlanMode / complete-event `plan_content` | Chat message | `switch_mode` tool `rawInput.plan` (string) |
| `TaskPlan` | Durable reviewed document, one per regular task, with revisions | `task_plans` (+ `TaskPlanRevision`) | MCP `create_task_plan_kandev` / `update_task_plan_kandev`, or the human in the Plan panel |
| Kanban `TaskStateTODO` | Board column | Task row | Humans / workflow / MCP task tools |

The first is the runtime internal checklist (observed). The third is the invented product plan (governed only when plan mode is on, and then only by prompt). They can be populated at the same time. That is two checklists competing.

### Lê checklist nativo?

**Sim, through ACP — not through the vendor-native stores named in `t-c2209d`.**

Channel 1 — ACP notification (file, event):

`apps/backend/internal/agentctl/server/adapter/transport/acp/adapter_updates.go:329-342`. On `u.Plan != nil`, each ACP `Plan.Entries` item becomes `streams.PlanEntry{Description: e.Content, Status: string(e.Status), Priority: string(e.Priority)}` and is emitted as `EventTypePlan`.

On `session/load`, `adapter_session.go:533-555` `emitReplayPlan` re-emits a captured `SessionUpdatePlan` so the todo indicator survives resume. An empty replay is **dropped** (lines 534-541): re-emitting it would wipe the live indicator and persist an empty snapshot that shadows the last real one. A live "agent cleared the todos" still arrives as a later plan update.

Channel 2 — todo-tool completion output (fallback when the runtime is MCP-shaped and does not emit ACP Plan):

`adapter_tools.go:785-798`. Comment: *"Todo tools from MCP-style runtimes report the final list in the completion output rather than through ACP's native plan notification. Feed those entries into the same plan stream Claude/Codex already use."* `planEntriesFromTodosResult` (`todos.go:7-21`) accepts `todos[]`, `metadata.todos[]`, or nested `rawOutput`, and item keys `content` | `text` | `description` (`todos.go:50-82`). Empty or fully-malformed arrays return `ok=false` so they do **not** emit a no-op that wipes the indicator (`todos.go:42-46`, tests in `todos_test.go:77-81`).

Channel 3 — ExitPlanMode markdown, **not** a checklist:

`adapter_tools.go:801-812`. If `rawInput.plan` is a non-empty string, emit `EventTypeAgentPlan` with `PlanContent`. Orchestrator `handleAgentPlanEvent` (`event_handlers_streaming.go:2437-2452`) stores it as `MessageTypeAgentPlan` (`task/models/models.go:1009-1012`).

Downstream (observation only):

- `event_handlers_streaming.go:166-170` routes `"plan"` → `handleSessionTodosEvent`, `"agent_plan"` → `handleAgentPlanEvent`.
- `handleSessionTodosEvent` (`:3351-3372`) publishes `session_todos.updated` and persists a `todo` chat message. Empty entries **are** persisted here — they mean the agent cleared the list (`:3375-3376`).
- Persistence shape (`:3381-3389`): `{text, status, done}` where `done` is `status == "completed"`. ACP/Codex item IDs, owners, and `blocks`/`blockedBy` are already gone before this point.
- UI: `apps/web/components/task/todos-panel-content.tsx:19-23, 32-39` reads `sessionTodos.bySessionId`, falls back to the latest persisted `todo` message, and if both are empty shows `chat:noTodosYet`. Display, not a write API.

**Not found as ingest** (and therefore not a reader of the surfaces `t-c2209d` measured):

- `~/.claude/tasks/<session>/`
- Codex app-server `turn/plan/updated` / `item/plan/delta`
- Grok `~/.grok/sessions/.../plan.json` and ACP `updates.jsonl` `TodosUpdated`
- OpenCode SQLite todo table / `todo.updated`

Kandev's Codex and Grok **dialects** (`dialect_codex.go`, `dialect_grok.go`) adjust session config, model, usage, and subagent frames. Grep for `plan` / `todo` in those two files: **empty**. Format differences at the vendor-native layer are not handled there.

Passthrough (raw TUI) has **no** `EventTypePlan` producer under `adapter/transport/`. `docs/public/feature-status.md:41`: *"Creating/updating the plan from an agent requires task MCP support; passthrough-only sessions do not have the same contract."*

### Inventou o próprio?

**Sim — a durable markdown TaskPlan, independent of the session todos.**

- Tools: `apps/backend/internal/mcp/server/server.go:1638-1670` `create_task_plan_kandev`, `get_task_plan_kandev`, `update_task_plan_kandev`, `delete_task_plan_kandev`. Content is markdown; `task_id` scopes the document.
- Model: `apps/backend/internal/task/models/models.go:1740-1766` — `TaskPlan` is HEAD content; `TaskPlanRevision` is the history. ADR `docs/decisions/0033-durable-plan-implementation-start.md` adds an implementation-start marker on `task_plans` so the Implement button does not infer state from chat.
- Prompt that *uses* it: `apps/backend/config/prompts/plan-mode.md` (injected only when plan mode is on) tells the agent to `get_task_plan_kandev`, edit, `update_task_plan_kandev` / `create_task_plan_kandev`, then **STOP**. `default-plan-prefix.md` is the same idea for the first turn when the workflow step did not already enable plan mode.

If the runtime also has a checklist, both live. Session todos update the indicator from ACP/todo-tools; TaskPlan is a separately edited document. Nothing in this tree merges them, diffs them, or picks a winner. `PlanEntry` has no `id` (`streams/agent.go:338-348`), so even the observed native list cannot round-trip Claude item IDs or Grok todo IDs.

### Exige plano?

**Não exige.** Plan mode is opt-in observation-plus-prompt, not a gate.

What exists:

- Caller or workflow can set `planMode`. `applyWorkflowAndPlanMode` (`task_operations.go:1412-1439`) ORs the flag with `OnEnterEnablePlanMode` on the step. If the caller asked for plan mode and the step did not already, it prepends `DefaultPlanPrefix()`. Later turns use `InjectPlanMode` (`sysprompt.go:338-341`) which wraps `plan-mode.md`.
- `setSessionPlanMode` (`event_handlers_workflow.go:3061-3078`) writes `session.Metadata["plan_mode"]` via `json_set`. It does **not** call ACP `session/set_mode`. It does **not** refuse the next prompt if `TaskPlan` is missing.
- Workflow can later `disable_plan_mode` on turn-complete or exit (`event_handlers_workflow.go:3116-3117`).
- A *different* workflow action, `set_session_mode`, may best-effort call ACP `session/set_mode` (`applyStepSessionMode`, `event_handlers_workflow.go:3080-3106`). That is a permission/mode switch (the example value in tests is `"plan"`). Passthrough is skipped. Failure is logged and ignored. This is not "no plan → no turn".

What does **not** exist (searched under `internal/orchestrator` for `ErrTaskPlanNotFound`, `plan required`, `must.*plan`, refuse-without-plan):

- No check that a `TaskPlan` row exists before `PromptTask`.
- No check that `PlanEntries` is non-empty before completing a turn.
- No retry when ACP never emits `Plan`.
- `plan-mode.md:19` says the instruction applies to **this prompt only**.

A workflow *can* put a step in plan mode and a later step behind a human wait (`feature-status.md:39-40`). That is a human gate after a prompted plan, not a runtime-enforced "always have a native checklist".

Passthrough: the same prompt prefix can still be injected (`applyWorkflowAndPlanMode` takes `isPassthrough` for workflow prompt assembly, not to skip plan-mode wrapping). The MCP tools the prefix names are not on that contract. That is a prompt that cannot be obeyed, not a gate.

### Multi-runtime? (the expensive part)

Kandev runs Claude and Codex (and Grok, OpenCode, …) as ACP agents in the same product. Reconciliation is **ACP-as-lowest-common-denominator**, plus a duck-typed todo-tool scraper.

What is kept (`streams/agent.go:338-348`, `todos.go:69-82`):

```text
PlanEntry { description, status, priority }
```

Status is an unnormalized string. The struct comment lists `"pending", "in_progress", "completed", "failed"`. Codex native schema (2026-08-16) uses camelCase `inProgress` and has no `failed`. Kandev does not map those spellings. If ACP already normalized, the string arrives clean; if a todo-tool dumps vendor status through `RawOutput`, it is stored verbatim (`todos.go:80`).

What is dropped, with no adapter:

| Native fact (`t-c2209d`) | After Kandev flatten |
|---|---|
| Claude item `id`, `owner`, `blocks` / `blockedBy` | gone (`PlanEntry` has no id / owner / edges) |
| Codex `turnId` on `turn/plan/updated`; no per-step id | never subscribed; no turn correlation on `PlanEntry` |
| Grok stable todo ids; merge vs replace | gone; last snapshot wins |
| OpenCode position-keyed rows, `cancelled` | only if the todo-tool fallback sees `content`/`text`/`description` |
| ExitPlanMode markdown | **other event** (`agent_plan`), not merged into session todos |

`newACPDialect` (`dialect.go:48-56`) special-cases Grok and Codex for **config/model/subagent**, not for plan. There is no `dialect.normalizePlan`. Claude and Codex plans become the same `[]PlanEntry` because both (when speaking ACP) already emit `SessionUpdatePlan`. That hides the incompatibility rather than translating it.

If Claude and Codex run as two sessions on one task, each session has its own `sessionTodos.bySessionId` key. The durable `TaskPlan` is per-task, not per-runtime. Nothing in this tree reconciles "Claude's ACP plan said X" with "Codex's ACP plan said Y" into that document.

### Runtime mudo?

Measured, not inferred:

- Never emitted a plan: live store stays empty; UI says there are no todos yet (`todos-panel-content.tsx:32-39`). That is "not observed", rendered as empty. It is not a fabricated list of items. It is also not a distinguished "runtime silent" state — empty and silent look the same.
- Resume with empty captured plan: **hidden** (`emitReplayPlan` returns). Last persisted todo message remains the timeline truth.
- Live empty list: **persisted** as a clear (`persistTodoMessage` with `len==0`).
- Malformed / empty todo-tool output: ignored (`todos.go:42-46`), so the previous indicator stays. The product does not claim the list is empty when it failed to parse.

No path was found that invents checklist items when the runtime said nothing.

---

## Cross-cutting

### Observation vs governance

| | Observes native checklist | Invents a list | Requires a plan before work |
|---|---|---|---|
| herdr | no | no | no |
| hive | no | yes (dormant GFM file + prompt) | no |
| kandev | yes (ACP + todo-tool scrape) | yes (TaskPlan MCP document) | no |

None of the three govern the runtime to **require** a native internal plan on every task. Kandev is the only one that can *show* the native list, and the only one that can *ask* (via prompt, when a human or workflow turns plan mode on) for a *different* document.

### Reconciliation (why this lote is the expensive one)

herdr and hive host Claude and Codex side by side and never see either plan format, so they never hit the incompatibility.

kandev hits it by **not translating**. ACP `Plan` is treated as already common. Vendor-native fields that ACP does not carry (Claude DAG, Codex `turnId`, Grok ids) are discarded. A second, product-owned markdown plan sits next to the flattened list and is what plan-mode actually governs. Passthrough — the path closest to how Tachyon hosts a TUI — observes neither.

### What this lote does not claim

- Behavior of a live authenticated session (no model call, no running herdr/hive/kandev).
- Whether a particular ACP agent implementation actually emits `SessionUpdatePlan` on today's Claude/Codex/Grok versions — only that Kandev will ingest it if it does.
- Anything about Tachyon product design. The owner decides after seeing what exists.
