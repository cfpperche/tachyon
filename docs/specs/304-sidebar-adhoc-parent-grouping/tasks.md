# 304 — sidebar-adhoc-parent-grouping — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Update `src/sidebar/sortRows.ts`'s module header comment to note it also holds the parent-grouping step (dueto finding 3).
- [x] Add `groupByParent<T>(rows, getName, getParent)` to `src/sidebar/sortRows.ts`: root-first depth-first emission (each parentless/orphaned row followed by its children, recursively, via a `visited` guard), then a final cleanup pass appending any still-unvisited row (cycle safety, dueto finding 1) in its original order.
- [x] Wire `groupByParent` into `src/webview/sidebar/App.tsx`'s `Panel` Agents branch (`:223-224`), composed immediately after the existing `sortRows()` call. Terminals/Pipelines/Schedules branches untouched.

## Verification

- [x] `groupByParent`: a child sorts immediately after its parent (maps to spec.md scenario "A spawned child agent sorts adjacent to its parent").
- [x] `groupByParent`: multiple children keep their existing relative sorted order under both name-asc and name-desc (maps to "Sort direction still controls ordering within and across groups").
- [x] `groupByParent`: an orphaned child (parent not present in the row set) stays in its normal alphabetical position (maps to "A child whose parent is absent from the list degrades gracefully").
- [x] `groupByParent`: does not mutate the input array (same convention as `sortRows`).
- [x] `groupByParent`: a lineage cycle renders every row exactly once, no infinite loop (maps to "A lineage cycle never drops a row or hangs the UI" — required, dueto finding 1).
- [x] `groupByParent`: a depth-2 chain (grandchild) still renders under its grandparent — defensive/robustness coverage only, not asserting a spec.md acceptance scenario (dueto finding 2).
- [x] Typecheck passes.

**Headless check:** `env -u TMUX npx vitest run test/unit/sortRows.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

**Verify:** `env -u TMUX npx vitest run test/unit/sortRows.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood-Opt-Out:** Pure reorder of a Preact list driven by a unit-tested pure function (`groupByParent`); the one-line `App.tsx` wiring has no branching logic of its own to exercise headlessly beyond what the unit suite already proves. Visual confirmation (an ad-hoc agent's row actually rendering under its parent in the running extension) is left to human dogfood below.

**Human dogfood:** Rebuild + reload the extension, spawn an ad-hoc sub-agent from a running agent (e.g. via `spawn_agent` with `parent=<name>`), and confirm in the sidebar Agents list that the child row (with its `↳`/"spawned by" badge) now appears immediately after its parent row, in both sort directions.
