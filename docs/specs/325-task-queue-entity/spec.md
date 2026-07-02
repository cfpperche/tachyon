# 325 — task-queue-entity

_Created 2026-07-02._

**Status:** draft

## Intent

_Origin: pin `p-96da7e`, co-designed with the maintainer 2026-07-02 (Mission Control). This spec is PART 1 of the v1 — the entity + Bridge contract; the editor-area board panel and the shared studio are follow-up specs._

The project's work queue currently lives inside pins, which overloads them: pins are the maintainer's reminders/records, but they've been carrying priorities faked as tags, states faked as title edits, and "what should I work on next" re-derived by every agent from a flat ~30-item list. The maintainer decided: **pins stay reminders; a new TASK entity is the project's work queue**, independent of pins (no modeled relation, no promotion flow).

A task is `{id, title, body?, status, priority, kind, author, assignee?, spec_ref?, deps?, createdAt/updatedAt}` — where `author` is who created it (human or agent, immutable, mirroring pins' `by`) and `assignee` is who is responsible NOW, deliberately mutable across stages (planning by one agent, execution by another; no assignee history in v1 — Activity/handoff already record who did what). Explicitly decided AGAINST a capability/classification field (mechanical/reasoning etc.) — routing intelligence belongs to triage, not the schema. Tasks with `spec_ref` delegate their execution-stage truth to the spec's `**Status:**` line (anti-drift: no dual-write); the task's own `status` governs only the pre-/post-spec stages.

"Done" means: tasks persist locally (`.tachyon/tasks/`, atomic writes — the current `pins.json` write is NOT atomic and a lost-update race was observed live), humans and agents create/update them symmetrically through the Bridge, and `next_task(agent)` answers "what should I work on" deterministically and consistently for every agent.

## Acceptance criteria

- [ ] **Scenario: an agent creates a task that lands untriaged**
  - **Given** a running agent connected to the Bridge
  - **When** it calls `create_task(title, ...)` with its agent name
  - **Then** the task persists with `author=<agent>`, `status="inbox"`, no priority/assignee (triage is a deliberate later gesture), and the sidebar/board data source reflects it
- [ ] **Scenario: a human-created task carries the same shape**
  - **Given** the human creates a task (v1 surface: a Bridge call or palette command; the studio UI is a follow-up spec)
  - **When** it persists
  - **Then** `author="human"` and the same schema/validations apply — creation is symmetric
- [ ] **Scenario: assignee changes across stages without losing authorship**
  - **Given** a triaged task assigned to agent A
  - **When** `update_task(id, assignee: "B")` is called at a stage boundary
  - **Then** `assignee` becomes B, `author` is unchanged, `updatedAt` advances
- [ ] **Scenario: next_task is deterministic, dependency-aware, and agent-consistent**
  - **Given** a set of tasks in various states, some with `deps`
  - **When** any agent calls `next_task(agent)`
  - **Then** it returns the single best candidate: assigned-to-me first, then unassigned triaged (ownership over global priority — a deliberate, documented policy), ordered by priority then age then id; tasks with status `inbox`/`done`/`dropped`, assigned to someone else, or with UNRESOLVED deps (any dep not `done`/`dropped`; a dangling dep id counts as resolved) are never returned; an empty/blocked queue yields a structured `{empty, reason}` answer, never an error
- [ ] **Scenario: claiming a task is race-safe (dueto B2)**
  - **Given** two agents that both received the same unassigned task from `next_task` (it is ADVISORY, not a claim)
  - **When** both call `update_task(id, assignee: <self>, expect: {assignee: null})`
  - **Then** exactly one succeeds; the other gets a structured precondition failure and must re-query — compare-and-swap preconditions (`expect` on assignee/status/updatedAt) are enforced under the Bridge's in-process write serialization
- [ ] **Scenario: spec_ref delegates execution truth to the spec**
  - **Given** a task with `spec_ref: "325"` whose spec dir exists
  - **When** the task is read (list/next)
  - **Then** the entity does NOT store a parallel execution status — consumers derive the stage from the spec's `**Status:**` line; `update_task` rejects attempts to set a status that contradicts the delegation (fail-closed with a clear message)
- [ ] **Scenario: concurrent writes never lose an update**
  - **Given** two writers updating different tasks concurrently
  - **When** both persist
  - **Then** neither update is lost (per-task files + atomic tmp+rename, like `PinStore.writeDetailFile` — NOT the `pins.json` whole-list rewrite whose lost-update race was observed live on 2026-07-01)
- [ ] **Scenario: spec lifecycle edge-states surface instead of drifting (dueto M3)**
  - **Given** a task whose `spec_ref` points at a spec now marked `superseded`, `abandoned`, or `deferred`
  - **When** the task is listed/derived
  - **Then** the derived stage carries that spec status as an attention flag and the task remains `active` pending explicit re-triage (`update_task` allows `active → triaged` reopen); "blocked" is never a stored status — it is DERIVED from unresolved deps
- [ ] A field-mutability × status transition table is part of the contract (author immutable always; title/body/kind/priority/deps mutable in inbox/triaged/active; assignee mutable in triaged/active; transitions inbox→triaged→active→done, dropped from any, reopen done/dropped→triaged explicitly; spec_ref settable in triaged/active, clearable only in triaged) — `update_task` fails closed with a structured message on any violation
- [ ] `list_tasks` is bounded: omits `body` by default and caps results (default 100, `limit` param); a `get_task(id)` returns one full task — no unbounded Bridge payloads
- [ ] Bridge tools `create_task` / `get_task` / `update_task` / `list_tasks` / `next_task` are registered with zod-validated schemas following the pin-tool conventions (trimmed non-empty title ≤300, body ≤4000 code points, priority integer 0–3, status from the enum only, deps as task-id strings that MAY dangle; fail-closed errors; `onViewsChanged("tasks")` refresh hook)
- [ ] Pins are untouched: no schema change, no relation fields, no behavior change to `create_pin`/`list_pins`/`update_pin`/`complete_pin`

## Non-goals

- The Mission Control board panel (editor webview) and the shared pin-studio-based task editor — the immediate follow-up specs; this one is entity + contract only.
- Assignee history, comments, sprints, estimates, burndown (decided against for v1; Activity is the card's execution stream).
- Any capability/classification field on tasks (decided against — see pin p-96da7e).
- Pin→task promotion or any modeled pin relation (entities are independent by decision).
- External issue import (p-13b050 synergy) — later.
- Agent-class matching in `next_task` (v1.1+, needs tachyon.yml schema for agent class).

## Open questions

- Naming for the dueto: `author` vs `by` (house consistency with pins); tool prefix `task` vs something avoiding collision with SDD tasks.md vocabulary and harness task-tools.
- `next_task` when the queue is empty or everything is blocked: error vs structured "nothing to do" answer (lean: structured empty answer with the reason).
