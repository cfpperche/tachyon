# 354 — mission-control-task-watch — tasks

_Generated from `plan.md` on 2026-07-04. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add a debounced `.tachyon/tasks/*.json` watcher in `Workspace.create`.
- [x] Clear any pending task-watch debounce timer in `Workspace.dispose`.
- [x] Add headless coverage for watcher registration, task fan-out, debounce, and disposal.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Out-of-band task create/change/delete events call `onViewsChanged("tasks")`.
- [x] Rapid task events are coalesced.
- [x] Disposing the Workspace cancels the watcher and pending timer.

**Headless check:** `npm test -- test/unit/workspaceHeadless.test.ts && npx tsc --noEmit`
**Verify:** `npm test -- test/unit/workspaceHeadless.test.ts && npx tsc --noEmit`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** The behavior is a host filesystem event fan-out and is covered headlessly by triggering the registered watcher callbacks.

**Human dogfood:** Open Mission Control, write or edit a `.tachyon/tasks/t-*.json` file out-of-band, and confirm the board refreshes without using the Bridge.

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** No layout or visual styling changes.
