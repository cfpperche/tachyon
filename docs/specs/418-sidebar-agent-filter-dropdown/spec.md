# 418 — sidebar-agent-filter-dropdown

_Created 2026-07-19. Task: t-a9d1f2._

**Status:** shipped

**Closure:** Shipped 2026-07-19 in `4b7cfcf4`. The six status-filter pills were replaced by one counted native dropdown in the `AGENTS` title toolbar; filter semantics and session-local state remain unchanged, zero-count modes stay visible/disabled, and obsolete pill markup/CSS were removed. Headless Visual QA passed at 360×760 and 240×760 with tracked screenshots; focused tests, build, typecheck, and the 5,112-test full suite passed.

## Intent

The Agents tab currently spends a full second row on six status-filter pills. At narrow VS Code sidebar widths they wrap, consume scarce vertical space, and visually compete with the fleet itself. The section header already owns sort, metrics, and add actions, so filtering belongs in that same toolbar.

Replace the pills with one compact native dropdown in the `AGENTS` header row. Preserve the existing single-select state, labels, counts, zero-count availability, default `All`, reactive fleet filtering, and session-local lifetime. The selected filter must remain visible and accessible without adding another row or causing toolbar overflow.

## Acceptance criteria

- [x] **Scenario: filter from the Agents title toolbar**
  - **Given** an Agents fleet with multiple status buckets
  - **When** the user selects `Live`, `Needs you`, `Stopped`, `On task`, `Has focus`, or `All` from the header dropdown
  - **Then** the same single-select filter logic applies and every option displays its full-fleet dynamic count
- [x] **Scenario: remain compact at narrow sidebar widths**
  - **Given** the sidebar preview at representative 240–360 px widths
  - **When** the Agents header renders with metrics, sort, add, and filter controls
  - **Then** the toolbar stays on the title row without horizontal overflow, overlap, or a second filter row
- [x] **Scenario: preserve zero and empty states**
  - **Given** a category count of zero or a fleet with no agents
  - **When** the Agents tab renders
  - **Then** zero-count categories remain visible but unavailable in the dropdown, and the no-agent surface does not add an inert filter control
- [x] The dropdown has an accessible label/title that communicates the selected filter and count and uses native keyboard interaction.
- [x] Obsolete pill markup and pill-only CSS are removed.

## Non-goals

- Change the meaning or membership of any agent-status filter.
- Persist the session-local filter through extension reloads.
- Add multi-select filtering, custom filter creation, or a new host message.
- Reorganize the other Agents toolbar actions or other sidebar tabs.

## Open questions

None. The existing Pins native select establishes the sidebar's dropdown precedent.
