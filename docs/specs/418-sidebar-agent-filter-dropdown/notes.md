# 418 — sidebar-agent-filter-dropdown — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-19 — Reused a native select rather than a custom menu: the six fixed choices inherit keyboard, focus, and disabled-option behavior without new popover state.
- 2026-07-19 — The existing state was session-local and remains so. This task preserves current persistence semantics rather than silently inventing a host preference.
- 2026-07-19 — Headless preview markers confirmed `sidebar/default`. At 240 px, `.sec` measured 239 px wide, `.sec-actions` x=78.6/width=148.4, and the dropdown x=78.6/width=82.1; screenshots show metrics, sort, and add still on the same line with no clipping.
- 2026-07-19 — The Visual-QA evidence channel rejected attachment because this is a manually managed change worktree rather than an agent-owned worktree (`codex has no worktree`). Screenshots were therefore copied into this spec's tracked `evidence/` directory instead of being lost with worktree cleanup.

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Dogfood log

### 2026-07-20T01:32:54Z — pass (1/1) — source: tasks.md — commit: 19293a60ee2d535b4a0a7147f9f9af05639faec4
- `npx vitest run test/unit/agentStatusFilterDropdown.test.ts -t "Agents header dropdown" --maxWorkers=1` — pass

## Verification log

### 2026-07-20T01:32:54Z — pass (3/3) — source: tasks.md
- `npx vitest run test/unit/agentStatusFilter.test.ts test/unit/agentStatusFilterDropdown.test.ts test/unit/webviewPreviewRoutes.test.ts --maxWorkers=1` — pass
- `npm run typecheck` — pass
- `npm run build` — pass
