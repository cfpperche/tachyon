# 335 — mission-control-board — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task
reveals the plan is wrong, update `plan.md` before continuing. This delivery = the v1 gate; the spec's
"Gated v1.1" rank-reorder section is explicitly OUT (gesture inert)._

## Implementation

- [x] T1a Hoist TaskStore's transition literal to a module-level const + exported
  `allowedTransitions(status)`; `assertTransition` consumes it. 325's tests untouched and green.
- [x] T1b Export the candidate comparator from `src/tasks/nextTask.ts` (mechanical, behavior unchanged).
- [x] T1c `src/tasks/boardSnapshot.ts`: one-pass builder (listRaw → derive once per task → per-chip pure
  `nextTask()` calls → allowedDropStatuses → chip union) + `test/unit/boardSnapshot.test.ts` (incl. parity
  check: per-chip snapshot result === `TaskStore.next(chip)` for the same fixture).
- [x] T2 `src/tasks/boardModel.ts` (pure, DOM-free): columns + counts + comparator ordering + dropped
  bucket + spotlight/dim per chip + deterministic unknown-name colors; `test/unit/boardModel.test.ts`
  incl. the 500-task fixture (keyed identity preserved across a single-task mutation; loose perf assertion).
- [x] T3 Board surface: `src/webview/MissionControlPanel.ts` (singleton, HandoffPanel pattern) +
  `src/webview/mission-control/{App,main}.tsx` + command `tachyon.missionControl` + sidebar-header button +
  build entry points + `onViewsChanged("tasks")` wiring in extension.ts. Static render first: columns,
  cards (anatomy per spec), dropped toggle, chips, spotlight ring, "+ task" quick-add.
- [x] T4 Interactions: HTML5 DnD status drags with drag-start affordances from `allowedDropStatuses`,
  snap-back + toast on store rejection; quick controls (priority composes `rank:null`, assignee) as edit
  sessions (input survives pushes, CAS `expect:{updatedAt}` on submit, stale marker on CAS failure);
  mid-drag push queueing per plan. Extract the edit-session/mid-drag decision logic into pure helpers with
  unit tests.
- [x] T5 Detail surface: `src/webview/TaskDetailPanel.ts` (per-task-id map, PinStudioPanelManager pattern,
  never auto-dispose; tombstone for missing/corrupt) + `src/webview/task-detail/{App,main}.tsx` (full task,
  sanitized markdown body, deps linked → `openTask`, quick controls shared with cards, live refresh).
- [x] T6 Hardening: malicious-markdown sanitizer tests; CSP identical to the strictest existing panel;
  full suite + both typechecks green (prove any pre-existing failure via stash).

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Open-the-board scenario (singleton, columns+counts, comparator order, dropped toggle) — covered by
  boardModel tests (`test/unit/boardModel.test.ts`) + `missionControlPanel.test.ts` (singleton reveal). Human
  dogfood still outstanding (see Dogfood section below).
- [x] Card anatomy + arbitrary-name colors — boardModel tests (color determinism, `colorTokenFor`). Visual QA
  screenshots still outstanding (see Visual QA section below).
- [x] Drag affordances + fail-closed drop — `missionControlInteractions.test.ts` (`resolveDrop`) + the new
  `allowedTransitions parity with assertTransition` suite in `taskStore.test.ts` (all 20 (from≠to) status pairs).
- [x] Triage in place + edit sessions — `missionControlInteractions.test.ts` (`priorityPatch` always composes
  `rank:null`, `assigneePatch`, `isStaleError`); `taskDetailPanel.test.ts` exercises the CAS `expect` path
  end-to-end through the store.
- [x] Spotlight — `boardSnapshot.test.ts` parity test (snapshot `next` === `TaskStore.next`) + `boardModel.test.ts`
  spotlight/dim tests.
- [x] Live refresh incl. mid-drag queueing — `missionControlInteractions.test.ts` (`resolveDrop` validates
  against the LATEST task, the queueing decision the App holds mid-drag); `missionControlPanel.test.ts` /
  `taskDetailPanel.test.ts` cover the `onViewsChanged("tasks")` → `refreshAll()` wiring at the panel-manager level.
- [x] Create from board — `missionControlPanel.test.ts` ("applies a create-from-board action with
  author:human…": inbox, no priority/assignee even if the message claims otherwise).
- [x] Detail view + lifecycle tombstone — `taskDetailPanel.test.ts` (tombstone from last-known-state on a
  vanished file, Done tasks stay open/live, deps resolved incl. dangling). Human dogfood still outstanding.
- [x] Markdown/CSP hardening — `markdownHardening.test.ts` (script/iframe/event-handler escaping,
  `command:`/`vbscript:`/`data:` URI rejection) + `webviewShellParity.test.ts` (mission-control/task-detail
  carry the same STANDARD CSP as every other migrated panel).
- [x] Scale envelope — 500-task fixture test in `boardModel.test.ts` (keyed order stable across a single-task
  mutation, loose perf assertion).
- [x] `npm test` and both typechecks green — 152 test files / 2096 tests passing, `tsc --noEmit` +
  `tsc -p tsconfig.webview.json` clean (no pre-existing failures to control for — the suite was already green
  before this delivery and stayed green throughout).

**Headless check:** `npm test -- --run test/unit/boardSnapshot.test.ts test/unit/boardModel.test.ts test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/boardSnapshot.test.ts test/unit/boardModel.test.ts test/unit/taskStore.test.ts test/unit/nextTask.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/boardModel.test.ts -t "500"` — ran clean (1 passed, 7 skipped by `-t`).
<!-- Headless proxy: the scale-envelope fixture exercises the full snapshot→model→ordering pipeline the
     board renders from. The rendered surfaces themselves need the human pass below — NOT run by this delivery
     (no way to install a VSIX and drive VS Code UI headlessly); tracked as outstanding, see notes.md. -->

**Human dogfood:** Install the VSIX, seed a handful of tasks via create_task (varied priority/kind/assignee,
one with an sdd artifact_ref, one with deps), open "Tachyon: Mission Control": drag a card
Inbox→Triaged→Active (assignee gate should fail closed with a toast until assignee is set), watch an
agent-side update_task appear live, select an agent chip and check the spotlight matches next_task, click a
card and use the detail tab (markdown body, quick controls, live updates), drop a task and find it behind
the Dropped toggle.

## Visual QA

- [x] Evidence: agent-screen captures on the installed builds at .tachyon/evidence/spec335-board-{1,2,3}.png
  and spec335-round2-board.png (populated board, codex chip selected with next_task spotlight, chips overflow,
  Dropped toggle) + maintainer screenshots of each dogfood round in the session transcript.
- [x] Verdict: PASS — final surface matches the approved prototype language (design-system tokens, sidebar
  agent dots, P0-P3 accent chips, spotlight ring); all 15 findings across 4 human dogfood rounds remediated
  and re-verified by the maintainer on the installed 0.55.4/0.55.5 builds.
