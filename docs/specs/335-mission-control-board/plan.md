# 335 — mission-control-board — plan

_Drafted from `spec.md` on 2026-07-03 (post-dueto). This delivery targets the **v1 gate**: every acceptance
criterion except the "Gated v1.1 — in-column rank reorder" section, which stays inert (no reorder gesture;
order falls back to priority → createdAt → id since no rank exists until the board mints one)._

## Approach

Four layers, mirroring the sidebar/pin-studio discipline (pure model modules + thin panel managers + Preact
surfaces):

1. **`src/tasks/boardSnapshot.ts`** (engine-side) — builds the spec's "board snapshot" in ONE pass:
   - `TaskStore.listRaw()` once → derive SDD once per task. Do NOT call `TaskStore.next()` per chip (it
     re-lists and re-derives); call the pure `nextTask()` from `src/tasks/nextTask.ts` with the
     already-derived map, once per chip.
   - `allowedDropStatuses` per task: export the transition map from `TaskStore.ts` as a pure
     `allowedTransitions(status: TaskStatus): TaskStatus[]` (move the literal out of `assertTransition` to a
     module-level const both consume — one authority, zero duplication). Status affordances only; the store
     still owns non-status invariants (active-needs-assignee, SDD gates) and drops can still fail closed.
   - Chips: union of declared agents (Workspace agent list), `"human"`, and assignee strings found in
     tasks; per-chip `nextTask` result or `{empty, reason}`.
2. **`src/tasks/boardModel.ts`** (pure, DOM-free, unit-tested) — snapshot → view model: columns
   (inbox/triaged/active/done + a dropped bucket for the toggle), per-column counts, card ordering by the
   `next_task` comparator (export the comparator from `nextTask.ts` rather than re-encoding it), spotlight
   resolution + dim-set per selected chip, deterministic colors for unknown assignee/kind names (hash →
   categorical palette index; declared agents keep the sidebar's colors).
3. **Panel managers**:
   - `src/webview/MissionControlPanel.ts` — singleton per workspace (HandoffPanel pattern), command
     `tachyon.missionControl` + sidebar-header button; `refreshAll()` posts a fresh snapshot.
   - `src/webview/TaskDetailPanel.ts` — map keyed by task id (PinStudioPanelManager pattern);
     `refreshAll()` re-posts each open task by id independent of board filters; missing/corrupt id →
     tombstone payload, never auto-dispose.
4. **Preact surfaces** (`src/webview/mission-control/{App,main}.tsx`, `src/webview/task-detail/{App,main}.tsx`)
   on design-system.css + shared webview plumbing:
   - Drag: native HTML5 DnD, no new deps. Drag-start dims columns outside `allowedDropStatuses` and blocks
     drop there. Drop posts `updateTask{id, patch:{status}, expect:{updatedAt}}`.
   - Edit sessions: local state keyed (taskId, field); snapshot pushes update everything except the active
     input; submit carries `expect:{updatedAt}` from session start; CAS failure → stale marker + retry.
   - Mid-drag push queueing: hold the latest snapshot in a ref while a drag is active, apply at drag end;
     on drop, validate the dragged card's status/priority against the queued model — stale → cancel + toast.
   - Priority quick-edit composes `rank:null` into its patch (dueto F5 — board-side, no store change).
   - Markdown in detail: reuse the pin-preview/pin-studio markdown pipeline IF it sanitizes; otherwise write
     a small allowlist renderer. Either way strip script/event-handlers/iframes/`command:` URIs/remote
     images, unit-tested with malicious payloads.

**Message protocol** (webview ⇄ extension): ext→webview `snapshot{...}` (board) / `task{view|tombstone}`
(detail); webview→ext `updateTask{id,patch,expect}`, `createTask{title,kind?,body?}` (author:"human"),
`openTask{id}`, `requestSnapshot{}`. All mutations route through TaskStore engine-side; store errors return
as `error{taskId,message}` → toast + snap-back.

**Wiring**: extension.ts instantiates both managers; `onViewsChanged("tasks")` → both `refreshAll()`s
(alongside the existing sidebar refresh); command contribution in package.json; two new webview entry points
added wherever the sidebar/handoff bundles are declared; CSP copied from the strictest existing panel.

## Key decisions

- **Snapshot precomputes next_task per chip** — chosen for one consistent filesystem view per push and zero
  disk reads on chip click (dueto F4); rejected per-click `TaskStore.next()` because it re-reads SDD specs
  from disk per task per call.
- **`allowedTransitions` exported from TaskStore** — chosen so drag affordances and `assertTransition` share
  one literal (dueto F6 without rule duplication); rejected webview-side rules (spec non-goal) and rejected
  no-affordances (snap-back-only UX, dueto F6).
- **Rank reorder deferred to the v1.1 gate** — dueto F1/F2 blockers demand store-owned atomic rebalance +
  CAS collision rejection; the board is fully useful for triage without reorder. Rejected shipping midpoint
  minting without the rebalance/concurrency story (silent order corruption risk).
- **Native HTML5 DnD** — chosen to keep zero new dependencies in the webview bundle; rejected dnd libs
  (bundle weight, CSP surface) — the interaction is column-drop + snap-back, not free sorting (v1).
- **Detail panel never auto-closes** (tombstone on missing/corrupt) — dueto F8; rejected closing-on-delete
  because it yanks a surface out from under the user.

## Files touched

- `src/tasks/boardSnapshot.ts` (new) — one-pass snapshot builder.
- `src/tasks/boardModel.ts` (new) — pure snapshot → view-model mapper.
- `src/tasks/nextTask.ts` — export the candidate comparator (mechanical; behavior unchanged).
- `src/tasks/TaskStore.ts` — hoist the transition literal to an exported `allowedTransitions` helper
  (mechanical; `assertTransition` consumes it; 325's tests stay green and untouched).
- `src/webview/MissionControlPanel.ts`, `src/webview/TaskDetailPanel.ts` (new) — panel managers.
- `src/webview/mission-control/{App,main}.tsx`, `src/webview/task-detail/{App,main}.tsx` (new) — surfaces.
- `src/extension.ts`, `package.json`, webview build entry-point config — wiring.
- `test/unit/boardSnapshot.test.ts`, `test/unit/boardModel.test.ts`, markdown-sanitizer test (new).

## Risks & unknowns

- `TaskStore.ts` was just shipped+reviewed (325): keep its refactor mechanical so review deltas stay trivial.
- Webview bundling config differs per surface — follow `src/webview/sidebar` exactly rather than inventing.
- Markdown pipeline reuse depends on what pin-preview actually does; if it does not sanitize, do NOT copy it
  silently — write the allowlist renderer and note it for Task Studio to inherit.
- 500-task perf budget in unit tests must stay CI-tolerant (assert scaling behavior/keyed identity, not
  tight wall-clock).

## Visual impact

Two brand-new editor surfaces (board + detail). Rendered per the approved prototype
(/tmp/mission-control/index.html): design-system tokens, sidebar-matching agent dots, P0–P3 accent chips,
spotlight ring + "▶ next_task(agent)" tag. What could look wrong: column overflow behavior with many cards
(each column scrolls independently, board scrolls horizontally), chip contrast for hashed colors, toast
placement. Proof: human visual dogfood on an installed VSIX against a seeded task set (+ the 500-task
fixture for responsiveness).

## Sources consulted

- docs/specs/325-task-queue-entity/{spec,notes}.md + src/tasks/* (entity semantics, review findings).
- Design dueto probe-97f2d13a (12 findings folded into spec.md; disposition in notes.md).
- src/webview/PinStudioPanel.ts (per-entity panel manager), HandoffPanel.ts (singleton panel),
  src/webview/sidebar/* (Preact + design-system stack), extension.ts onViewsChanged wiring.
- Prototype /tmp/mission-control/index.html (approved visual language, pin p-96da7e).
