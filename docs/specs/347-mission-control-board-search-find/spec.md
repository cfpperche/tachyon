# 347 — mission-control-board-search-find

_Created 2026-07-03._

**Status:** shipped
**Closure:** Toolbar search (t-5ea4c7) and the native find widget (t-b5e6e5) both shipped and are green on typecheck/build/unit suite + an agent visual pass. Spec intentionally NOT closed via `/sdd close` — the maintainer's own dogfood pass is still outstanding (per the tasks' own instructions), so this stays `shipped` until that happens.

**Verify:** `npx vitest run test/unit/boardModel.test.ts && npm run typecheck && npm run build`
**Dogfood:** `node scripts/webview-preview/serve.mjs` then open `http://localhost:PORT/scripts/webview-preview/index.html?view=mission-control&fixture=default`, type into the toolbar search box, and try Ctrl+F in the real installed extension's Mission Control panel.

## Intent

Maintainer request (dogfood 335 round 4 + a 2026-07-03 Chrome-find screenshot) for two DISTINCT, complementary ways to locate something on the Mission Control board:

- **t-5ea4c7** — a generalized search/filter in the toolbar: type a term, non-matching cards disappear. Combines with the existing agent-filter dropdown (which only dims cards, never hides them).
- **t-b5e6e5** — a browser-like Ctrl+F find-in-view: highlight + navigate matches WITHOUT hiding anything else on the board. Cheapest path first: `enableFindWidget: true` on the panel's `WebviewPanelOptions`, evaluated against two named caveats (nested column scroll, collapsed Dropped content) before building any custom fallback.

These two gestures must stay visibly distinct: search/filter is destructive to the view (things vanish), find is purely additive (nothing moves, nothing is hidden).

## Acceptance criteria

- [x] **Scenario: toolbar search hides non-matching cards**
  - **Given** the board has cards with varying title/id/kind/assignee/body
  - **When** a user types a term into the toolbar search box
  - **Then** only cards whose title, id, kind, assignee, or body contain that term (case-insensitive) remain visible, in every column and in the Dropped bucket, and column/Dropped counts reflect the filtered set.
- [x] **Scenario: clearing the search restores the board**
  - **Given** a non-empty search query
  - **When** the field is cleared
  - **Then** every card reappears with the original counts.
- [x] **Scenario: search combines with the agent filter without conflict**
  - **Given** both an agent selected in the dropdown and a search term
  - **Then** the agent filter continues to only dim (never hide), while search hides — the two mechanisms compose, neither overrides the other's semantics.
- [x] **Scenario: native find widget is enabled**
  - **Given** `MissionControlPanel` (and, piggybacking cheaply, `TaskDetailPanel`, `TaskStudioPanel`, the Pin Preview panel in `SidebarPrototype.ts`, and `HandoffPanel`)
  - **Then** each panel's `createWebviewPanel` options carry `enableFindWidget: true`.
- [x] **Scenario: find-widget caveats are validated, not assumed**
  - **Given** a column whose cards overflow its own `overflow-y` scroll region, and the Dropped column collapsed behind its toggle
  - **Then** the validation result (does the browser's find primitive reach a below-the-fold match in a nested scroller; does it ever reach content not in the DOM) is recorded in `notes.md`, with an honest account of the test method's limits.
- [x] Neither gesture touches `TaskStore.ts`, `nextTask.ts`, or `tools.ts`.

## Non-goals

- A custom find-in-board fallback (highlight + n/N navigation) — only built if the native widget were proven insufficient for the maintainer's stated ask; the validation in `notes.md` concluded the cheap path is adequate for the common case, with one honestly-documented gap (collapsed Dropped content).
- Searching/finding inside the validation strip — out of scope for both tasks' bodies.
