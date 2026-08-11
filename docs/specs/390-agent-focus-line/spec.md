# 390 — agent-focus-line

_Created 2026-07-16._

**Status:** shipped
**Closure:** Landed on main in commit `9af59fd7`; v1 acceptance is checked and the spec records approved POC plus closed Dev Host dogfood on 2026-07-16.
**Status detail:** closed (2026-07-16)

**Branch:** `grok/agent-focus-line-poc` → main

## Intent

With many agents live, the human cannot see **what each agent is working on** at a glance.
Existing row chrome answers *state*, not *subject*.

Ship a **focus line** per AI agent row: one short string from existing sources (task → brief → continuity goal), plus **On task** / **Has focus** filters. Live-dot replaces a redundant `working` chip; tree indent replaces “delegated by” text.

**POC approved** 2026-07-16 — `docs/specs/390-agent-focus-line/prototype.html`.
**Dogfood closed** 2026-07-16 — fixture `test/fixtures/agent-focus-line-dogfood` + Dev Host.

## Acceptance criteria

- [x] POC HTML reviewed and approved
- [x] **Scenario: task assignee wins**
  - **Given** an open MC task with `assignee = agent`
  - **When** the sidebar row renders
  - **Then** focus shows task id + title (source task)
- [x] **Scenario: brief for child without task**
  - **Given** ad-hoc child with spawn contract/taskBrief and no open task
  - **Then** focus shows brief text (source brief)
- [x] **Scenario: continuity goal fallback**
  - **Given** no task/brief but continuity has Current Goal
  - **Then** focus shows that goal (source goal/continuity)
- [x] **Scenario: omit when empty**
  - **Given** no task, brief, or goal
  - **Then** no focus line (no invented work)
- [x] **Scenario: filters**
  - **When** On task / Has focus selected
  - **Then** roster filters accordingly
- [x] No `working` badge on rows; live-dot remains
- [x] No “delegated by / spawned by” text on rows (hierarchy indent only)
- [x] Terminals do not get a focus line
- [x] Child meta/focus lines align under the child name (no parent toggle-gutter pad)

## Non-goals (v1)

- Scraping last tool call as focus
- New `set_focus` Bridge tool
- Manual pin override
- Extra L2 badge for focus

## Open questions

None blocking v1 after POC — click-through to MC is best-effort if a command already exists.
