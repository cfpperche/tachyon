# 347 — mission-control-board-search-find — plan

_Drafted from `spec.md` on 2026-07-03 (written alongside/just after implementation — this was task-tracked work, not spec-first)._

## Approach

**t-b5e6e5 first (cheapest):** add `enableFindWidget: true` to the `WebviewPanelOptions` literal already passed to `vscode.window.createWebviewPanel` in `MissionControlPanel.ts`, then piggyback the same one-line change onto `TaskDetailPanel.ts`, `TaskStudioPanel.ts`, `HandoffPanel.ts`, and the Pin Preview panel (`SidebarPrototype.ts`'s `previewPin`). Validate the two named caveats using a synthetic-overflow fixture rendered through a real Chrome instance (agent-browser) rather than assuming Chromium/Electron find behavior.

**t-5ea4c7:** add a pure `matchesBoardSearch(task, query)` predicate to `boardModel.ts` (case-insensitive substring across title/id/kind/assignee/body), thread an optional `searchQuery` through `BoardModelInput`, and filter each column's tasks (and the Dropped bucket) before building cards — so counts and card lists both reflect the filtered set. In `App.tsx`, add a toolbar search box with two pieces of state: `searchInput` (what the field shows, instant) and `searchQuery` (what actually drives `buildBoardModel`, debounced 200ms via a `useEffect`/`setTimeout`) — so typing feels instant without re-deriving the model per keystroke.

## Key decisions

- **Filter in `boardModel.ts`, not `App.tsx`** — chosen to match the file's existing "webview never computes affordances itself" discipline (same reasoning `agentFilterOptions` already follows); rejected filtering the rendered `BoardCardVM[]` in the component because it would duplicate field access logic and drift from the pure/testable model.
- **Search HIDES, agent-filter DIMS — kept deliberately different** — the task bodies for both t-5ea4c7 and t-b5e6e5 call this out explicitly; conflating the two into one filtering mechanism would erase a distinction the maintainer asked to preserve.
- **Debounce via `useEffect` + `setTimeout`, not a ref-based custom hook** — the codebase has no existing debounce utility; a 4-line effect matches the file's existing inline-`setTimeout` style (toast auto-dismiss, menu-open-focus) rather than introducing a new abstraction for one call site.
- **Validate the find-widget caveats empirically before deciding on a fallback** — rather than assume Chromium/Electron scroll-into-view semantics, built a synthetic-overflow fixture (41 cards in one column + a uniquely-named card in the collapsed Dropped bucket) and drove it through a real Chrome instance via the `agent-browser` skill. See `notes.md` for the full account, including where the test method itself has limits (browser chrome — the actual find toolbar UI — isn't visible to a CDP screenshot, so `window.find()` was used as a proxy, with the caveat that it is a different Blink code path from the toolbar's `TextFinder`/`webContents.findInPage`).
- **No custom find fallback built** — the spec's own instruction was fallback-only-if-insufficient; the one confirmed gap (collapsed Dropped content is outside the DOM, so unfindable by definition) is a narrow, expected edge case, not a blocker for the maintainer's stated "find text on the board like the browser" ask.

## Files touched

- `src/tasks/boardModel.ts` — `matchesBoardSearch`, `searchQuery` on `BoardModelInput`, filter columns/dropped.
- `src/webview/mission-control/App.tsx` — toolbar search box, debounced state, wired into `buildBoardModel`.
- `src/webview/mission-control/mission-control.css` — `.board-search` / `.board-search-clear` styling.
- `src/webview/MissionControlPanel.ts`, `TaskDetailPanel.ts`, `TaskStudioPanel.ts`, `HandoffPanel.ts`, `SidebarPrototype.ts` — `enableFindWidget: true`.
- `test/unit/boardModel.test.ts` — `matchesBoardSearch` unit coverage + `buildBoardModel` filtering coverage.
- `docs/specs/347-mission-control-board-search-find/*` — this record.

## Risks & unknowns

- The find-widget validation used `window.find()` in an automated Chrome instance as a proxy for VS Code's actual `enableFindWidget` behavior (Electron's `webContents.findInPage`, i.e. Blink's `TextFinder`). These are different code paths in Blink; the automated test's negative scroll result should NOT be read as proof the real find toolbar fails to scroll nested overflow — see `notes.md` for the full reasoning and the recommendation to have the maintainer's own Ctrl+F dogfood be the real acceptance test for that specific caveat.
- The collapsed-Dropped-content gap is real and provable from code alone (conditional render — `{showDropped && <Column .../>}` — means the DOM subtree doesn't exist when collapsed), independent of any live-browser test.

## Visual impact

Mission Control's toolbar gains a search box (icon + input + conditional clear button) between the title and the agent-filter dropdown. No other visual changes; the four piggybacking panels change zero visible pixels (find widget is host-chrome, not webview content).

## Sources consulted

- `src/webview/mission-control/App.tsx`, `boardModel.ts`, `boardSnapshot.ts` (existing board architecture).
- `scripts/webview-preview/` harness (used read-only via a temporary, deleted-before-commit scratch fixture — not the in-flight spec-346 preview-catalog work already touching that directory).
