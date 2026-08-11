# Spec 259 — Sidebar tab scroll

**Status:** shipped
**Closure:** Implemented on main in commit `22acfdd9`; validation recorded `npm test`, typecheck, build, dark/light render harness, and DOM scroll-container probe, with no residual.

## Intent

The Tachyon sidebar currently lets the whole side view scroll when a tab has many rows. That moves or partially hides the search box, tab bar, section header, and Bridge footer. Keep the shell controls static and make only the active tab panel scroll, so long sections such as Pins can be browsed without losing navigation or Bridge status.

## Acceptance

- [x] **Scenario: Long tab content scrolls inside the tab panel**
  - **Given** a sidebar tab with more rows than fit vertically
  - **When** the user scrolls the sidebar
  - **Then** the scrollbar belongs to the active tab panel, not the whole webview body.

- [x] **Scenario: Sidebar shell stays static**
  - **Given** the user is scrolled deep inside a long tab
  - **When** they inspect the sidebar shell
  - **Then** the search bar, tab bar, section header, and Bridge footer remain visible and do not move with the row list.

- [x] **Scenario: Search selection still reveals the target row**
  - **Given** the user picks an item from Cmd/Ctrl+K in any tab
  - **When** the target tab opens
  - **Then** the target row scrolls into view inside the tab panel and flashes as before.

- [x] Existing sidebar actions, tab keyboard navigation, multi-root grouping, and Bridge copy behavior remain unchanged.

## Non-goals

- No redesign of the sidebar taxonomy, tab order, row density, icons, or footer content.
- No persistence of scroll position across sessions.
- No change to Pins storage, pin CRUD, project handoff, or Bridge tool behavior.

## Context / references

- Pin `p-eca2d9` in `/home/goat/Agent0/.tachyon/pins/p-eca2d9.json`.
- `src/webview/SidebarPrototype.ts` owns the sidebar shell CSS.
- `src/webview/sidebar/App.tsx` owns the active tab panel and Cmd/Ctrl+K row reveal behavior.
