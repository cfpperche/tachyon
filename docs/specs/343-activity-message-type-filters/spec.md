# 343 — activity-message-type-filters

_Created 2026-07-03._

**Status:** shipped
**Closure:** Shipped view-only Activity type filters in the webview: fixed user-facing categories, search composition, hidden count, show-all reset, session-local persistence, unit coverage, typecheck, build, and preview evidence (`/tmp/activity-filter-full.png`).
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The Activity panel currently renders every normalized activity item in one feed. On active sessions this mixes chat messages, thinking, tool calls, injected context, Tachyon nudges, images, usage records, errors, files, commands, and session boundaries. Pin `p-521c54` asks for a way to enable/disable visible Activity messages by type.

Done means the Activity UI exposes a compact filter control that lets a human hide or show message categories without changing the durable `.tachyon/activity/*.jsonl` log. Filtering is reversible, works together with the existing recent-activity search, and makes it obvious when items are hidden.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: hide one category**
  - **Given** an Activity feed containing chat messages and tool activity
  - **When** the user disables the tool/activity category
  - **Then** tool/file/usage/error rows are hidden while chat messages remain visible
- [x] **Scenario: combine search and type filters**
  - **Given** a non-empty Activity feed
  - **When** the user enters a search term and disables one category
  - **Then** the rendered feed contains only loaded items matching both the search and the enabled categories
- [x] **Scenario: restore all categories**
  - **Given** one or more categories are hidden
  - **When** the user clicks the reset/show-all control
  - **Then** all item kinds become visible again
- [x] **Scenario: hidden count**
  - **Given** filters hide at least one loaded item
  - **When** Activity renders the feed
  - **Then** the UI shows a concise hidden-item count so the feed never looks silently incomplete
- [x] The durable activity log and normalized event model are unchanged; this is a view-only filter.
- [x] Filter preferences persist for the Activity webview session and do not require restarting the agent.

## Non-goals

- No full-transcript server-side search.
- No mutation or pruning of `.tachyon/activity/*.jsonl`.
- No per-agent or workspace settings surface in v1.
- No custom user-defined categories beyond the fixed Activity UI categories.

## Open questions

- Category grouping is implementation-owned: use a small user-facing set rather than exposing every internal `ActivityItem.kind` as a separate checkbox.
