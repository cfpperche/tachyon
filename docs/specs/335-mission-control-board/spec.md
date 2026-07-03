# 335 — mission-control-board

_Created 2026-07-02._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Spec 325 shipped the Task entity and its five bridge tools, but the only surfaces today are MCP calls and
raw JSON files — a human cannot see the queue, triage the inbox, or watch what the fleet is pulling. The
decided direction (pin p-96da7e) is an own kanban: **Mission Control**, a webview panel in the EDITOR area
(deliberately not the sidebar — too cramped), fed by the TaskStore and refreshed live by the
`onViewsChanged("tasks")` hook the 325 implementation already fires.

Done looks like: one command opens a per-workspace Mission Control tab showing tasks as cards in
status columns; the human triages by dragging (all invariants enforced by the store, board fails closed);
assignee is editable in place; a `next_task` spotlight shows exactly what an agent would pull next — the
same query agents run, so human and fleet share one truth. Visual language follows the approved prototype
(/tmp/mission-control/index.html) rendered with the real design-system tokens.

## Acceptance criteria

- [ ] **Scenario: open the board**
  - **Given** a workspace with tasks in `.tachyon/tasks/`
  - **When** the user runs the "Tachyon: Mission Control" command (also reachable from the sidebar header)
  - **Then** a singleton editor panel opens for that workspace (re-running focuses the existing tab) showing
    columns **Inbox / Triaged / Active / Done** with per-column counts, each task as a card ordered by the
    same comparator as `next_task` (priority → rank → createdAt → id); Dropped is reachable behind a toggle,
    not a fifth always-on column
- [ ] **Scenario: card anatomy**
  - **Given** a task with priority, kind, assignee, an sdd artifact ref and attention items
  - **When** its card renders
  - **Then** it shows title, task id, P0–P3 chip (err/warn/info accents per the prototype), kind chip,
    assignee (agent color dot + name, matching the sidebar's dots), a derived SDD status chip when present,
    and attention badges (`dangling_dep`, `missing_sdd_spec`, `ready_to_close`, `sdd_needs_retriage`) with
    the store's message as tooltip — body is NOT rendered on cards (bounded board, `list_tasks` summary shape)
- [ ] **Scenario: drag = status transition**
  - **Given** a card being dragged to another column
  - **When** the drop violates a store invariant (illegal transition, active without assignee, SDD gate)
  - **Then** the board calls `TaskStore.update` (engine-side, not MCP), the card snaps back, and the store's
    structured error is surfaced as a toast — the webview embeds NO transition rules of its own
- [ ] **Scenario: triage in place**
  - **Given** a card in Inbox or Triaged
  - **When** the user edits priority or assignee from the card's quick controls
  - **Then** the change persists via the same guarded update path and the board re-renders from a fresh
    `listViews` push (no optimistic divergence)
- [ ] **Scenario: in-column reorder mints rank**
  - **Given** two cards with equal priority in the same column
  - **When** the user drags one above the other
  - **Then** the board writes a `rank` between the neighbors' ranks (codepoint-ordered midpoint string) and
    the resulting order equals what `next_task` would see — the board is the writer of `rank`, agents only read
- [ ] **Scenario: next_task spotlight**
  - **Given** agent filter chips in the header (union of declared agents, `human`, and any assignee string
    present in tasks — ad-hoc assignees always get a chip; colors from the sidebar)
  - **When** the user selects a chip
  - **Then** the card that `TaskStore.next(<agent>)` returns gets the spotlight treatment from the prototype
    (accent ring + "▶ next_task(<agent>)" tag) and an empty result shows the structured reason inline; the
    chip filter also dims cards not assigned to (or claimable by) that agent
- [ ] **Scenario: live refresh**
  - **Given** an open board
  - **When** any task mutates through the bridge tools (agent-side) or the board itself
  - **Then** `onViewsChanged("tasks")` re-pushes state to every open Mission Control panel (wired in
    extension.ts like the handoff/probe panel managers) — no polling
- [ ] **Scenario: create from the board**
  - **Given** the header's "+ task" action
  - **When** the user submits title (+ optional kind/body)
  - **Then** the task lands in Inbox via `TaskStore.create` with `author:"human"`, matching the create tool's
    posture (no priority/assignee at birth — triage is a deliberate later gesture)
- [ ] **Scenario: task detail view**
  - **Given** a card on the board
  - **When** the user clicks it
  - **Then** a task DETAIL webview opens as a new editor tab (panel-manager pattern, one per task id;
    re-clicking focuses the existing tab) showing the full task: title, body rendered as markdown, status,
    priority, kind, author, assignee, deps (linked to their tasks), artifact_refs, derived SDD status and
    attention items — read-only in v1 except the same quick controls the card offers (status/priority/
    assignee); rich editing (screenshots, sketches) remains Task Studio's job, and the detail tab reflects
    live task mutations like the board does — explicitly NOT a dialog or modal (maintainer decision)
- [ ] The panel is implemented with the house webview stack (Preact + design-system.css + panel-manager
  pattern of PinStudio/Handoff), CSP-compliant, no external resources
- [ ] A pure, unit-tested board model module (`src/tasks/boardModel.ts` or similar) maps `TaskView[]` →
  columns/cards/spotlight — DOM-free, mirroring the sidebar's agentModel/actions discipline
- [ ] Rank minting is a pure, unit-tested function (between(a, b) with append/prepend edges and rebalance
  fallback when no midpoint exists)

## Non-goals

- **Task Studio** — the rich create/edit surface (screenshots, sketches, markdown body editing — the pin
  studio's feature set). Separate follow-up spec; the board's "+ task" is a minimal quick-add only.
- Board-side enforcement of transition/mutability rules (store is the single authority; board only renders
  its errors).
- Multi-workspace aggregation, WIP limits, swimlanes, column customization, done-column archival/aging.
- Pin integration of any kind — pins and tasks stay fully independent (p-96da7e decision).
- Realtime multi-window conflict resolution beyond last-write + live refresh (cross-process CAS is a known
  325 limitation, recorded in its notes).

## Open questions

_All three initial forks were resolved by the maintainer (2026-07-02) and promoted into acceptance criteria:
Dropped is toggle-reveal, not a permanent column; card click opens a task detail webview tab in the editor
(explicitly not a dialog/modal); agent filter chips are the union of declared agents + assignee strings
found in tasks (ad-hoc assignees always get a chip)._
