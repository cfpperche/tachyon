# 354 — mission-control-task-watch

_Created 2026-07-04._

**Status:** shipped
**Closure:** Shipped locally: Workspace now watches `.tachyon/tasks/*.json` and debounces out-of-band task file create/change/delete events into the existing `onViewsChanged("tasks")` fan-out. Verification passed via `/sdd verify` on 2026-07-04.

## Intent

Mission Control refreshes when Tachyon mutates tasks through the Bridge or panels, but an already-open board does not
refresh when `.tachyon/tasks/*.json` changes out-of-band: direct file edits, generated task JSON, git pulls, or another
window writing the same workspace. The project already watches `.tachyon/*`, but that does not cover nested task files.

Done means each Workspace installs a debounced task-file watcher that fans out the existing `onViewsChanged("tasks")`
path whenever task JSON files are created, changed, or deleted.

## Acceptance criteria

- [x] **Scenario: out-of-band task file write refreshes Mission Control**
  - **Given** an open Workspace with Mission Control already showing a snapshot
  - **When** `.tachyon/tasks/t-*.json` is created, changed, or deleted outside the Bridge/panel mutation path
  - **Then** Tachyon calls the existing task fan-out (`onViewsChanged("tasks")`) after a short debounce.
- [x] The watcher is disposed with the Workspace.
- [x] The existing `.tachyon/*` watcher for pins/schedules remains unchanged.

## Non-goals

- No recursive watcher for every `.tachyon/**` file.
- No new Mission Control polling loop.
- No change to TaskStore's persistence format.

## Open questions

None.
