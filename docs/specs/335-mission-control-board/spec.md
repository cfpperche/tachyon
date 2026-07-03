# 335 — mission-control-board

_Created 2026-07-02._

**Status:** in-progress
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

**Delivery gates (dueto F12, accepted):** the v1 gate is the board core (every criterion below except the
"gated v1.1" section). In-column rank reorder is a **gated v1.1** criterion inside this same spec: the board
ships and is useful without it, and its concurrency semantics (dueto F1/F2/F3/F5) must not block basic
triage. The task detail tab stays in v1 — maintainer decision, and without it `body` is invisible.

## Board snapshot (data contract)

One push = one **board snapshot** built engine-side in a single pass: `TaskView[]` (bounded, `listViews`
shape) **plus** per-task `allowedDropStatuses` (computed by the store's own transition authority — exported
from the store module, never re-encoded in the webview) **plus** precomputed `next_task` result/empty-reason
for every agent chip in the header. Derived SDD reads are done once per snapshot, so every card, chip and
spotlight in one push reflects a single consistent filesystem view (dueto F4, accepted); chip clicks select
among snapshot results and never trigger per-chip disk scans.

## Acceptance criteria

- [x] **Scenario: open the board**
  - **Given** a workspace with tasks in `.tachyon/tasks/`
  - **When** the user runs the "Tachyon: Mission Control" command (also reachable from the sidebar header)
  - **Then** a singleton editor panel opens for that workspace (re-running focuses the existing tab) showing
    columns **Inbox / Triaged / Active / Done** with per-column counts, each task as a card ordered by the
    same comparator as `next_task` (priority → rank → createdAt → id); Dropped is reachable behind a toggle,
    not a fifth always-on column
- [x] **Scenario: card anatomy**
  - **Given** a task with priority, kind, assignee, an sdd artifact ref and attention items
  - **When** its card renders
  - **Then** it shows title, task id, P0–P3 chip (err/warn/info accents per the prototype), kind chip,
    assignee (agent color dot + name), a derived SDD status chip when present, and attention badges
    (`dangling_dep`, `missing_sdd_spec`, `ready_to_close`, `sdd_needs_retriage`) with the store's message as
    tooltip — body is NOT rendered on cards (bounded board, `list_tasks` summary shape)
- [x] **Scenario: chip/dot colors for arbitrary names** (dueto F11, accepted)
  - **Given** an assignee or kind string with no declared agent/known value behind it
  - **When** its dot/chip renders
  - **Then** declared agents use the sidebar's colors, `human` uses the sidebar human token, and unknown
    strings get a deterministic hash into a design-system categorical palette (stable across sessions,
    contrast-checked) — never a blank or session-random color
- [x] **Scenario: drag = status transition, illegal targets marked at drag-start** (dueto F6, accepted)
  - **Given** a card being dragged
  - **When** the drag starts
  - **Then** columns not in that task's snapshot `allowedDropStatuses` render as non-targets (dimmed, drop
    prevented) — affordances come from the store via the snapshot, the webview still embeds NO rules
  - **When** a drop on a legal target is rejected anyway (raced mutation, SDD gate, active-without-assignee)
  - **Then** the board calls `TaskStore.update` (engine-side, not MCP), the card snaps back, and the store's
    structured error is surfaced as a toast
- [x] **Scenario: triage in place**
  - **Given** a card in Inbox or Triaged
  - **When** the user edits priority or assignee from the card's quick controls
  - **Then** the change persists via the same guarded update path with CAS `expect:{updatedAt}` from the edit
    session's starting version, and the board re-renders from a fresh snapshot push (no optimistic
    divergence); a priority quick-edit also sends `rank:null` so a rank minted in another priority lane never
    leaks into the new one (dueto F5, accepted — board-side composition, no store change)
- [x] **Scenario: edit sessions survive live refresh** (dueto F7, accepted)
  - **Given** an open inline editor (assignee/priority) on a card
  - **When** a snapshot push arrives mid-edit
  - **Then** surrounding card data updates but the active input value is preserved; on submit, CAS
    `expect:{updatedAt}` from the session start applies — a CAS failure marks the editor stale and requires
    retry from the refreshed value (typed input is never silently discarded or applied to a newer version)
- [x] **Scenario: next_task spotlight**
  - **Given** agent filter chips in the header (union of declared agents, `human`, and any assignee string
    present in tasks — ad-hoc assignees always get a chip)
  - **When** the user selects a chip
  - **Then** the card the snapshot's precomputed `next_task(<agent>)` names gets the spotlight treatment from
    the prototype (accent ring + "▶ next_task(<agent>)" tag), an empty result shows its structured reason
    inline, and the chip filter dims cards not assigned to (or claimable by) that agent — no disk reads on
    chip click (dueto F4)
- [x] **Scenario: live refresh**
  - **Given** an open board
  - **When** any task mutates through the bridge tools (agent-side) or the board itself
  - **Then** `onViewsChanged("tasks")` re-pushes a fresh snapshot to every open Mission Control panel (wired
    in extension.ts like the handoff/probe panel managers) — no polling
  - **When** a push arrives while a drag is active (dueto F3, accepted — applies to status drags too)
  - **Then** the board stores the fresh model but does not patch the dragged lane's DOM until drag end; the
    drop validates against the latest snapshot, and if the source card's status/priority changed underneath,
    the drop cancels with a stale-board toast and the queued refresh applies
- [x] **Scenario: create from the board**
  - **Given** the header's "+ task" action
  - **When** the user submits title (+ optional kind/body)
  - **Then** the task lands in Inbox via `TaskStore.create` with `author:"human"`, matching the create tool's
    posture (no priority/assignee at birth — triage is a deliberate later gesture)
- [x] **Scenario: task detail view**
  - **Given** a card on the board
  - **When** the user clicks it
  - **Then** a task DETAIL webview opens as a new editor tab (panel-manager pattern, one per task id;
    re-clicking focuses the existing tab) showing the full task: title, body rendered as sanitized markdown,
    status, priority, kind, author, assignee, deps (linked to their tasks), artifact_refs, derived SDD status
    and attention items — read-only in v1 except the same quick controls the card offers; rich editing stays
    Task Studio's job; explicitly NOT a dialog or modal (maintainer decision)
- [x] **Scenario: detail panel lifecycle** (dueto F8, accepted)
  - **Given** an open detail tab for a task
  - **When** the task moves to Done/Dropped, or its file disappears or becomes unparseable
  - **Then** the panel subscribes by task id independently of board filters: Done/Dropped tasks stay open and
    update live; a missing/corrupt task renders a read-only tombstone with the last known state and disabled
    quick controls — the panel is never auto-closed under the user
- [x] **Markdown/CSP hardening** (dueto F9, accepted): the webviews use the house CSP posture (nonce'd local
  bundles, no inline script, no external network, img-src local/data only) and the detail tab's markdown
  rendering strips script/event handlers/iframes/command: URIs/remote images — with unit tests feeding
  malicious markdown through the renderer
- [x] A pure, unit-tested board model module (`src/tasks/boardModel.ts` or similar) maps a board snapshot →
  columns/cards/spotlight/drop-affordances — DOM-free, mirroring the sidebar's agentModel/actions discipline
- [x] **Scale envelope** (dueto F10, accepted): board model tests include a 500-task fixture; rendering uses
  keyed card updates so a single task mutation does not rebuild unrelated cards' interactive state; the
  dogfood includes the 500-task fixture staying responsive through refresh, chip selection and drag start

### Gated v1.1 — in-column rank reorder (dueto F1/F2/F3/F5, accepted; ships only with its own gate green)

- [ ] **Scenario: in-column reorder mints rank**
  - **Given** two cards with equal priority in the same column
  - **When** the user drags one above the other
  - **Then** the board first attempts a single-task write: `TaskStore.update` of the dragged task's `rank`
    (codepoint-ordered midpoint between the neighbors as observed in the board's snapshot) with CAS
    `expect:{status, updatedAt}`; a stale snapshot or rank collision in the same status/priority lane rejects
    fail-closed with a "board changed — retry" toast and a fresh snapshot (no last-write rank collisions)
- [ ] Rank midpoint minting is a pure, unit-tested function (`between(a, b)` with append/prepend edges);
  when no midpoint exists, the board invokes a **store-owned** reorder operation that rewrites the minimal
  same-status/same-priority rank window atomically under the store's mutation lock (rebalance planning pure
  and unit-tested; execution integration-tested for CAS failure and partial-write prevention) — reorder is
  disabled (drag-to-reorder inert, order falls back to createdAt/id) until this criterion is green

## Non-goals

- **Task Studio** — the rich create/edit surface (screenshots, sketches, markdown body editing — the pin
  studio's feature set). Separate follow-up spec; the board's "+ task" is a minimal quick-add only.
- Board-side enforcement of transition/mutability rules (store is the single authority; the snapshot's
  `allowedDropStatuses` are store-computed affordances, not webview-owned rules).
- Multi-workspace aggregation, WIP limits, swimlanes, column customization, done-column archival/aging.
- Pin integration of any kind — pins and tasks stay fully independent (p-96da7e decision).
- Cross-window conflict MERGING: stale writes fail closed via CAS + re-render (dueto F2 tightened the old
  "last-write wins" posture — collisions are rejected, not merged).

## Open questions

_All three initial forks were resolved by the maintainer (2026-07-02) and promoted into acceptance criteria:
Dropped is toggle-reveal, not a permanent column; card click opens a task detail webview tab in the editor
(explicitly not a dialog/modal); agent filter chips are the union of declared agents + assignee strings
found in tasks. The design dueto's 12 findings are folded above (accept/rebut log in notes.md)._
