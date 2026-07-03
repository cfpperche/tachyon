# 335 — mission-control-board — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task
reveals the plan is wrong, update `plan.md` before continuing. This delivery = the v1 gate; the spec's
"Gated v1.1" rank-reorder section is explicitly OUT (gesture inert)._

## Implementation

- [ ] T1a Hoist TaskStore's transition literal to a module-level const + exported
  `allowedTransitions(status)`; `assertTransition` consumes it. 325's tests untouched and green.
- [ ] T1b Export the candidate comparator from `src/tasks/nextTask.ts` (mechanical, behavior unchanged).
- [ ] T1c `src/tasks/boardSnapshot.ts`: one-pass builder (listRaw → derive once per task → per-chip pure
  `nextTask()` calls → allowedDropStatuses → chip union) + `test/unit/boardSnapshot.test.ts` (incl. parity
  check: per-chip snapshot result === `TaskStore.next(chip)` for the same fixture).
- [ ] T2 `src/tasks/boardModel.ts` (pure, DOM-free): columns + counts + comparator ordering + dropped
  bucket + spotlight/dim per chip + deterministic unknown-name colors; `test/unit/boardModel.test.ts`
  incl. the 500-task fixture (keyed identity preserved across a single-task mutation; loose perf assertion).
- [ ] T3 Board surface: `src/webview/MissionControlPanel.ts` (singleton, HandoffPanel pattern) +
  `src/webview/mission-control/{App,main}.tsx` + command `tachyon.missionControl` + sidebar-header button +
  build entry points + `onViewsChanged("tasks")` wiring in extension.ts. Static render first: columns,
  cards (anatomy per spec), dropped toggle, chips, spotlight ring, "+ task" quick-add.
- [ ] T4 Interactions: HTML5 DnD status drags with drag-start affordances from `allowedDropStatuses`,
  snap-back + toast on store rejection; quick controls (priority composes `rank:null`, assignee) as edit
  sessions (input survives pushes, CAS `expect:{updatedAt}` on submit, stale marker on CAS failure);
  mid-drag push queueing per plan. Extract the edit-session/mid-drag decision logic into pure helpers with
  unit tests.
- [ ] T5 Detail surface: `src/webview/TaskDetailPanel.ts` (per-task-id map, PinStudioPanelManager pattern,
  never auto-dispose; tombstone for missing/corrupt) + `src/webview/task-detail/{App,main}.tsx` (full task,
  sanitized markdown body, deps linked → `openTask`, quick controls shared with cards, live refresh).
- [ ] T6 Hardening: malicious-markdown sanitizer tests; CSP identical to the strictest existing panel;
  full suite + both typechecks green (prove any pre-existing failure via stash).

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Open-the-board scenario (singleton, columns+counts, comparator order, dropped toggle) — covered by
  boardModel tests + human dogfood.
- [ ] Card anatomy + arbitrary-name colors — boardModel tests (color determinism) + visual QA.
- [ ] Drag affordances + fail-closed drop — pure-helper tests (affordance mapping) + parity test that
  `allowedTransitions` matches `assertTransition` acceptance/rejection for every status pair.
- [ ] Triage in place + edit sessions — pure-helper tests (session survives push, CAS expect composed,
  priority patch carries rank:null).
- [ ] Spotlight — boardSnapshot parity test (snapshot next === TaskStore.next) + boardModel spotlight tests.
- [ ] Live refresh incl. mid-drag queueing — pure-helper tests for the queueing decision; wiring smoke via
  existing extension test surface if present.
- [ ] Create from board — snapshot/store test (author:"human", inbox, no priority/assignee).
- [ ] Detail view + lifecycle tombstone — panel unit tests where feasible; human dogfood for the live tab.
- [ ] Markdown/CSP hardening — sanitizer unit tests with malicious payloads.
- [ ] Scale envelope — 500-task fixture tests.
- [ ] `npm test` and both typechecks green.

**Headless check:** `npm test -- --run test/unit/boardSnapshot.test.ts test/unit/boardModel.test.ts test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/boardSnapshot.test.ts test/unit/boardModel.test.ts test/unit/taskStore.test.ts test/unit/nextTask.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/boardModel.test.ts -t "500"`
<!-- Headless proxy: the scale-envelope fixture exercises the full snapshot→model→ordering pipeline the
     board renders from. The rendered surfaces themselves need the human pass below. -->

**Human dogfood:** Install the VSIX, seed a handful of tasks via create_task (varied priority/kind/assignee,
one with an sdd artifact_ref, one with deps), open "Tachyon: Mission Control": drag a card
Inbox→Triaged→Active (assignee gate should fail closed with a toast until assignee is set), watch an
agent-side update_task appear live, select an agent chip and check the spotlight matches next_task, click a
card and use the detail tab (markdown body, quick controls, live updates), drop a task and find it behind
the Dropped toggle.

## Visual QA

- [ ] Evidence: screenshots of the board (populated, chip selected with spotlight, drag affordances mid-drag)
  and the detail tab, captured on the installed build against the seeded task set.
- [ ] Verdict:
