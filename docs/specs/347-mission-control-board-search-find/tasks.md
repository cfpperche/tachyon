# 347 — mission-control-board-search-find — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete._

## Implementation

- [x] Validate `enableFindWidget` caveats (nested-column scroll, collapsed Dropped content) via a synthetic fixture in a real browser.
- [x] Add `enableFindWidget: true` to `MissionControlPanel.ts`.
- [x] Piggyback `enableFindWidget: true` onto `TaskDetailPanel.ts`, `TaskStudioPanel.ts`, `HandoffPanel.ts`, and the Pin Preview panel (`SidebarPrototype.ts`).
- [x] Add `matchesBoardSearch` to `boardModel.ts` (title/id/kind/assignee/body, case-insensitive).
- [x] Thread `searchQuery` through `BoardModelInput`; filter columns + Dropped bucket before building cards.
- [x] Add the toolbar search box to `App.tsx` (debounced 200ms) with a clear affordance.
- [x] Style `.board-search` in `mission-control.css`.
- [x] Unit tests for `matchesBoardSearch` and `buildBoardModel` search filtering.
- [x] Record find-widget caveat validation + visual QA in `notes.md`.

## Verification

- [x] `npx vitest run` (full suite) green.
- [x] `npm run typecheck` (main + webview + browser-test tsconfigs) green.
- [x] `npm run build` (esbuild) green.
- [x] Agent visual pass of the search box (type → filters/counts update → clear → restores) via `agent-browser` against a temporary, deleted-before-commit scratch fixture.

**Headless check:** `npx vitest run test/unit/boardModel.test.ts && npm run typecheck && npm run build`

**Verify:** `npx vitest run test/unit/boardModel.test.ts && npm run typecheck && npm run build`

## Dogfood

**Dogfood:** `npm run preview:webview` then open `http://localhost:PORT/scripts/webview-preview/index.html?view=mission-control&fixture=default`, type into the toolbar search box, and try Ctrl+F in the real installed extension's Mission Control panel.

**Maintainer dogfood still outstanding** — this spec ships but does NOT close; the maintainer's own pass (especially Ctrl+F against a real, busy board) is the actual acceptance test for the find-widget caveats, per the task's own instructions.
