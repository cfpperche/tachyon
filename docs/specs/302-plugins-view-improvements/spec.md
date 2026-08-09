# 302 — plugins-view-improvements

_Created 2026-06-30._

**Status:** shipped
**Closure:** 2026-06-30 — Plugins View now has sourced-only per-card Check update actions, an Installed toolbar with filter/sort/count, a no-results filtered state, and host-side single-plugin update checking that merges into existing status checks. Validated by unit tests, typecheck, build, headless preview smoke, and agent-browser screenshot evidence at `docs/specs/302-plugins-view-improvements/evidence/plugins-default.png`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm test -- --run test/unit/pluginsListControls.test.ts test/unit/pluginViewModel.test.ts test/unit/webviewPreviewPluginsFixture.test.ts && npm run -s typecheck && npm run -s build`
**Dogfood:** `bash docs/specs/302-plugins-view-improvements/smoke.sh`

## Intent

The Plugins View currently has one global "Check updates" action in the header and a long installed-plugin list rendered in fixed alphabetical order. With many installed plugins, checking one plugin requires scanning/updating the whole list, and finding a plugin requires manual scrolling.

Improve the installed-plugins surface with per-plugin update checks and lightweight list controls. Each installed plugin card should expose its own check-update action when the plugin came from a source that can be checked. The Installed tab should also have a compact toolbar for filtering and sorting the installed cards without changing the underlying lockfile model.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: check one plugin for updates**
  - **Given** the Plugins View has installed plugin cards, including a git-sourced plugin
  - **When** the user clicks that plugin card's check-update control
  - **Then** Tachyon resolves update status only for that plugin, updates that card's status badge, and does not clear unrelated update statuses
- [x] **Scenario: local plugins do not offer source checks**
  - **Given** an installed plugin has no git/source provenance
  - **When** its card is rendered
  - **Then** the card does not show a per-plugin check-update control
- [x] **Scenario: installed list can be filtered**
  - **Given** multiple installed plugins are visible
  - **When** the user types in the Installed toolbar filter
  - **Then** the list is narrowed by plugin name/source/runtime/status text and a no-results state appears when nothing matches
- [x] **Scenario: installed list can be sorted**
  - **Given** multiple installed plugins with different names/statuses/versions are visible
  - **When** the user changes the Installed toolbar sort
  - **Then** the rendered order changes without mutating the source view model
- [x] The global "Check updates" action remains available and still checks all sourced installed plugins.
- [x] The toolbar is scoped to the Installed tab and does not appear on Marketplace or empty/corrupt lockfile states.
- [x] The controls are responsive and do not cause card text/action overlap on the current desktop layout.

## Non-goals

- No marketplace search/filtering in this slice.
- No persisted filter/sort preferences.
- No change to plugin update resolution semantics, source pinning, or lockfile schema.
- No background polling or automatic update checks.
- No package/version release for Tachyon unless explicitly requested after validation.

## Open questions

- Resolved: use text+icon `Check` in the card action group so the action is explicit and accessible.
