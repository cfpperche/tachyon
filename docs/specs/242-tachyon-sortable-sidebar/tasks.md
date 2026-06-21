# Tasks 242 — sortable sidebar lists

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** ui (sidebar layout — Agents + Terminals; no project UI runner → dogfood in EDH/prod)

## Increment A — pure sortStatusRows + tests ✅
- [x] `src/sidebar/sortRows.ts`: generic `sortStatusRows(rows, mode, getName, getStatus)` (name-asc|name-desc|status, STATUS_RANK + name tiebreak, stable, locale-aware/numeric) + `asSortMode` + SORT_MODES/SORT_LABEL.
- [x] `test/unit/sortRows.test.ts` (7): each mode, tiebreak, numeric compare, no-mutate, coercion.

## Increment B — Agents flat render + sort menu + count chips ✅
- [x] Agents render as a flat `AgentRow` list via `sortStatusRows` (no status `Group`); keyed rows.
- [x] Header: `StatusChips` (per-status counts, SR-labeled) + sort icon-menu (A–Z/Z–A/Status (live), active checked) reusing the App menu.
- [x] Dot gains `title` + `aria-label` status text (D5/D10).

## Increment C — sort persistence (host, no flicker) ✅
- [x] `main.tsx` carries `prefs` in the fleet message + a `setSort` dispatch.
- [x] `SidebarPrototype` includes prefs in EVERY fleet message (D8 first-render) + `setSort` → synchronous cache + `globalState` persist + republish (D9, validated mode); `extension.ts` passes `context.globalState`.
- [x] `sortOverride` (session-authoritative) ?? persisted ?? name-asc; no revert on a stale fleet snapshot.

## Increment D — Terminals + finalize ✅
- [x] Terminals reuse the same flat render + `sortStatusRows` + the shared header control.
- [x] Codex impl review: SHIP-WITH-CHANGES → folded (setSort merge race → sync cache + validation; unkeyed rows → keyed; aria-label includes active mode).
- [x] 886 tests green; tsc + engine-boundary + build clean.

## Closure
**Closure:** Increments A–D shipped. Codex: plan SPEC-READY-WITH-CHANGES (D5 chips, D6 both twins, D7–D12) → impl SHIP-WITH-CHANGES (setSort merge race + unkeyed rows + aria) folded. Agents + Terminals are now flat, human-sorted (default Name A–Z = stable, no reflow), with per-status count chips + dot tooltips and a persisted (globalState, per-section) sort. Pipelines/Runbooks/Commands/Schedules/Pins unchanged. **EDH/prod visual validation pending** (the user's gate — pure UI); release notes must call out the silent A–Z default (D12). Deferred: "recently active" sort, drag-to-reorder, server-side identity unrelated.
