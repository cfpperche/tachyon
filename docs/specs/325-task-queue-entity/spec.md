# 325 — task-queue-entity

_Created 2026-07-02._

**Status:** shipped
**Closure:** Shipped 2026-07-02. Added the core Task entity/store under `.tachyon/tasks`, pure `nextTask()` selection, optional SDD artifact enrichment without SDD plugin dependency, Bridge tools `create_task`/`get_task`/`update_task`/`list_tasks`/`next_task`, Workspace refresh wiring for `tasks`, and focused/full verification. UI board/studio remains follow-up as scoped.

**Verify:** `env -u TMUX npx vitest run test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`
**Dogfood:** `env -u TMUX npx vitest run test/unit/taskStore.test.ts -t "CAS claim"`

## Intent

_Origin: pin `p-96da7e`, co-designed with the maintainer 2026-07-02 (Mission Control). This spec is PART 1 of the v1 — the entity + Bridge contract; the editor-area board panel and the shared studio are follow-up specs._

The project's work queue currently lives inside pins, which overloads them: pins are the maintainer's reminders/records, but they've been carrying priorities faked as tags, states faked as title edits, and "what should I work on next" re-derived by every agent from a flat ~30-item list. The maintainer decided: **pins stay reminders; a new TASK entity is the project's work queue**, independent of pins (no modeled relation, no promotion flow).

A task is `{id, title, body?, status, priority, rank?, kind?, author, assignee?, artifact_refs?, deps?, createdAt/updatedAt}` — where `author` is who created it (human or agent, immutable, mirroring pins' `by`) and `assignee` is who is responsible NOW, deliberately mutable across stages (planning by one agent, execution by another; `"human"` is a valid assignee; no assignee history in v1 — Activity/handoff already record who did what). Explicitly decided AGAINST a capability/classification field (mechanical/reasoning etc.) — routing intelligence belongs to triage, not the schema. `kind` is an optional open work-type label (`bug`, `feature`, `docs`, `research`, etc.) for filtering/grouping, not routing. `priority` is numeric for deterministic sorting: `0=urgent`, `1=high`, `2=normal`, `3=low`, absent means untriaged/no priority. `rank` is an optional human/board-controlled tie-breaker within the same priority; if absent, age falls back to `createdAt`. `artifact_refs` is an optional list of open references shaped as `{type: string, ref: string}`: known types can get richer behavior, but unknown types remain valid and are preserved. If a task has an SDD artifact reference (`{type:"sdd", ref:"..."}`) and the referenced local spec exists, execution-stage truth is derived from that spec's `**Status:**` line (anti-drift: no dual-write); otherwise the task's own `status` is the complete source of truth.

"Done" means: tasks persist locally (`.tachyon/tasks/`, atomic writes — the current `pins.json` write is NOT atomic and a lost-update race was observed live), humans and agents create/update them symmetrically through the Bridge, and `next_task(agent)` answers "what should I work on" deterministically and consistently for every agent.

## Acceptance criteria

- [x] **Scenario: an agent creates a task that lands untriaged**
  - **Given** a running agent connected to the Bridge
  - **When** it calls `create_task(title, ...)` with its agent name
  - **Then** the task persists with `author=<agent>`, `status="inbox"`, no priority/assignee (triage is a deliberate later gesture), and the sidebar/board data source reflects it
- [x] **Scenario: a human-created task carries the same shape**
  - **Given** the human creates a task (v1 surface: a Bridge call or palette command; the studio UI is a follow-up spec)
  - **When** it persists
  - **Then** `author="human"` and the same schema/validations apply — creation is symmetric
- [x] **Scenario: assignee changes across stages without losing authorship**
  - **Given** a triaged task assigned to agent A
  - **When** `update_task(id, assignee: "B")` is called at a stage boundary
  - **Then** `assignee` becomes B, `author` is unchanged, `updatedAt` advances
- [x] **Scenario: next_task is deterministic, dependency-aware, and agent-consistent**
  - **Given** a set of tasks in various states, some with `deps`
  - **When** any agent calls `next_task(agent)`
  - **Then** it returns the single best candidate: assigned-to-me first, then unassigned triaged (ownership over global priority — a deliberate, documented policy), ordered by priority then optional human `rank` then `createdAt` then id; tasks with status `inbox`/`done`/`dropped`, assigned to someone else, assigned to `"human"` when the caller is an agent, or with UNRESOLVED deps (deps only reference Task ids; any existing dep not `done`/`dropped` blocks; a dangling dep id counts as resolved but surfaces as attention) are never returned; an empty/blocked queue yields a structured `{empty, reason}` answer, never an error
- [x] **Scenario: active SDD-backed tasks resume only when still actionable**
  - **Given** an assigned `active` task with a recognized SDD artifact reference
  - **When** `next_task(<assignee>)` evaluates it
  - **Then** it remains eligible while the derived SDD status is still actionable (`draft`/`in-progress`/`shipped-partial`); it is excluded once the spec is `shipped`; and `superseded`/`abandoned`/`deferred` produce an attention/retriage state instead of normal execution selection
- [x] **Scenario: SDD shipped does not silently complete the task**
  - **Given** an `active` task whose SDD artifact reference is derived as `shipped`
  - **When** the task is listed or fetched
  - **Then** the task remains stored as `active`, surfaces a `ready_to_close` attention flag, and requires an explicit `update_task(status:"done")` to complete it
- [x] **Scenario: claiming a task is race-safe (dueto B2)**
  - **Given** two agents that both received the same unassigned task from `next_task` (it is ADVISORY, not a claim)
  - **When** both call `update_task(id, assignee: <self>, expect: {assignee: null})`
  - **Then** exactly one succeeds; the other gets a structured precondition failure and must re-query — compare-and-swap preconditions (`expect` on assignee/status/updatedAt) are enforced under the Bridge's in-process write serialization
- [x] **Scenario: an SDD artifact reference delegates execution truth when available**
  - **Given** a task with `artifact_refs: [{type:"sdd", ref:"325-task-queue-entity"}]` whose local spec dir exists
  - **When** the task is read (list/next)
  - **Then** the entity does NOT store a parallel execution status — consumers derive the stage from the spec's `**Status:**` line; `update_task` rejects attempts to set a status that contradicts the recognized SDD delegation (fail-closed with a clear message)
- [x] **Scenario: tasks remain fully functional without SDD**
  - **Given** a project with no SDD plugin, no `docs/specs`, or tasks with no SDD artifact reference
  - **When** tasks are created, listed, updated, claimed, and selected through `next_task`
  - **Then** all core task behavior works from the task's own fields; missing or unknown artifact references surface as context/attention only and never make the task queue unusable
- [x] **Scenario: concurrent writes never lose an update**
  - **Given** two writers updating different tasks concurrently
  - **When** both persist
  - **Then** neither update is lost (per-task files + atomic tmp+rename, like `PinStore.writeDetailFile` — NOT the `pins.json` whole-list rewrite whose lost-update race was observed live on 2026-07-01)
- [x] **Scenario: SDD lifecycle edge-states surface instead of drifting (dueto M3)**
  - **Given** a task whose SDD artifact reference points at a spec now marked `superseded`, `abandoned`, or `deferred`
  - **When** the task is listed/derived
  - **Then** the derived stage carries that spec status as an attention flag and the task remains `active` pending explicit re-triage (`update_task` allows `active → triaged` reopen); "blocked" is never a stored status — it is DERIVED from unresolved deps
- [x] A field-mutability × status transition table is part of the contract (author immutable always; title/body/kind/priority/rank/deps/artifact_refs mutable in inbox/triaged/active; assignee mutable in triaged/active and may be any non-empty string including `"human"`; transitions inbox→triaged→active→done, dropped from any, reopen done/dropped→triaged explicitly, and triaged→inbox to return a prematurely-triaged task for re-evaluation (amendment t-370286, 2026-07-03: inbox semantics relaxed from "never evaluated" to "needs (re-)evaluation"; the store clears assignee as part of this transition since inbox forbids it); SDD artifact refs settable in triaged/active, clearable only in triaged when they currently delegate execution truth) — `update_task` fails closed with a structured message on any violation
- [x] `list_tasks` is bounded: omits `body` by default and caps results (default 100, `limit` param); a `get_task(id)` returns one full task — no unbounded Bridge payloads
- [x] Persisted JSON stays the raw Task only; derived metadata (`attention`, SDD-derived stage, `ready_to_close`, dangling-dep warnings) is returned by `get_task`/`list_tasks`/`next_task` but never written into the task file
- [x] `get_task` and `list_tasks` surface non-blocking attention flags for inconsistent references: dangling deps, missing local SDD specs, `ready_to_close` for shipped SDD refs on active tasks, and SDD lifecycle states needing retriage; attention flags never change stored `status`
- [x] Bridge tools `create_task` / `get_task` / `update_task` / `list_tasks` / `next_task` are registered with zod-validated schemas following the pin-tool conventions (trimmed non-empty title ≤300, body ≤4000 code points, priority integer 0–3 with `0=urgent` and absent priority last, optional rank as a trimmed non-empty string ≤64, optional kind as a trimmed non-empty open string ≤64, status from the enum only, assignee as a trimmed non-empty open string, deps as task-id strings that MAY dangle, `artifact_refs` max 10 entries shaped as trimmed non-empty `type` ≤64 + `ref` ≤500 with open `type` values and duplicate `(type, ref)` pairs rejected; fail-closed errors; `onViewsChanged("tasks")` refresh hook)
- [x] Pins are untouched: no schema change, no relation fields, no behavior change to `create_pin`/`list_pins`/`update_pin`/`complete_pin`

## Non-goals

- The Mission Control board panel (editor webview) and the shared pin-studio-based task editor — the immediate follow-up specs; this one is entity + contract only.
- User-configurable kanban/workflow columns — a follow-up board/studio spec should let non-SDD projects define visual stages without changing the core task status enum.
- Assignee history, comments, sprints, estimates, burndown (decided against for v1; Activity is the card's execution stream).
- Any capability/classification field on tasks (decided against — see pin p-96da7e).
- Pin→task promotion or any modeled pin relation (entities are independent by decision).
- External issue import (p-13b050 synergy) — later.
- Agent-class matching in `next_task` (v1.1+, needs tachyon.yml schema for agent class).

## Resolved decisions

- Use `author`, not `by`, as the canonical task field. Pins keep `by`, but tasks need the clearer contrast between immutable creator (`author`) and mutable current owner (`assignee`).
- Keep the Bridge tool names literal: `create_task`, `get_task`, `update_task`, `list_tasks`, `next_task`. The MCP namespace makes them unambiguous, and alternative queue/work-item prefixes reduce clarity for agents.
- `next_task` returns a structured empty result for normal no-work states (`no-tasks`, `all-blocked`, `all-assigned-elsewhere`) instead of treating them as errors. Errors are reserved for invalid input, failed preconditions, corrupted state, or IO failures.
- Use plural `artifact_refs?: Array<{type:string, ref:string}>`, not `spec_ref`, so the task entity stays independent of SDD and can point at multiple local or external work artifacts. `type` is an open string: Tachyon may enrich known types such as `sdd`, `file`, `url`, `github_issue`, or `github_pr`, but unknown project-specific types remain valid data.
- Dangling deps are attention, not blockage: they likely indicate stale/manual data, but they must not deadlock the queue. Existing deps block until the referenced task is `done` or `dropped`.
- Keep the core task `status` enum small and operational (`inbox`/`triaged`/`active`/`done`/`dropped`) even though the first board/kanban thinking came from SDD. Custom user workflow columns belong in a later visual/studio layer, likely as config mapping project-specific lanes onto the fixed operational states and optional artifact-derived signals.
- Add optional `rank` as a human/board-controlled tie-breaker inside the same priority. `next_task` still falls back to `createdAt` then id when no rank is present, so editing a task does not reshuffle the queue via `updatedAt`.
- `kind` is a lightweight work-type label only; it must not become hidden routing/classification logic in v1.
- SDD-derived `shipped` means the execution artifact is done, not that the Task is automatically complete. The task stays explicit until `update_task(status:"done")`.
- SDD support must be implemented as optional artifact enrichment, not as a dependency on the SDD plugin runtime: no task API may require the plugin to be installed, and the only v1 SDD-specific behavior is best-effort reading of local spec files when an `artifact_refs` entry explicitly uses `type:"sdd"`.
