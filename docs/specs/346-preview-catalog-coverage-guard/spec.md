# 346 — preview-catalog-coverage-guard

_Created 2026-07-03._

**Status:** shipped
**Closure:** Mission Control is now registered in the canonical webview manifest, available in the preview catalog, covered by manifest/catalog guards, and visually verified at `/tmp/spec346-mission-control-preview.png`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Mission Control exists as a real converted webview, but it is missing from both `WEBVIEW_SURFACES` and the preview catalog. Spec 345 exposed this only during visual QA: Sidebar, Plugins, Task Detail, Task Studio, and Activity could be rendered through the preview harness, while Mission Control required manual installed-extension inspection.

The issue is broader than one missing route. `src/webview/surfaces.ts` already claims to be the canonical manifest of every Tachyon webview surface, but Mission Control was not listed there. The existing preview catalog coverage test only compares `WEBVIEW_SURFACES` to `ROUTES`, so it could not see a panel absent from the manifest itself. A converted webview can still be added to the product without being registered in the manifest, route table, fixture, catalog entry, or visual QA path.

Done means Mission Control is registered in `WEBVIEW_SURFACES`, has a working preview route, and the repo has automatic guards for both layers: real converted webview hosts must be represented in the manifest, and every manifest `converted: true` surface must either appear in `scripts/webview-preview/routes.ts` or be explicitly listed as a preview opt-out with a reason.

## Acceptance criteria

- [x] **Scenario: Mission Control previews**
  - **Given** the preview server is running
  - **When** `/scripts/webview-preview/index.html?view=mission-control&fixture=default` is opened
  - **Then** Mission Control renders through the same bundle, CSS order, and `snapshotMessage` envelope used by the real panel.
- [x] **Scenario: route catalog includes Mission Control**
  - **Given** `scripts/webview-preview/routes.json` is generated from `ROUTES`
  - **When** the catalog is inspected
  - **Then** it contains at least one `mission-control` entry with title and aliases.
- [x] **Scenario: converted surface without preview fails tests**
  - **Given** a future converted surface is added to `WEBVIEW_SURFACES`
  - **When** it is not added to `ROUTES` and is not listed in an explicit preview opt-out map
  - **Then** the unit suite fails with a message naming the missing view.
- [x] **Scenario: converted panel missing from manifest fails tests**
  - **Given** a real converted webview host such as `MissionControlPanel.ts`
  - **When** it is not represented in `WEBVIEW_SURFACES`
  - **Then** the unit suite fails with a message naming the missing host/view.
- [x] Mission Control is listed in `WEBVIEW_SURFACES` with view `mission-control` and host `src/webview/MissionControlPanel.ts`.
- [x] The coverage guard compares `WEBVIEW_SURFACES.filter(s => s.converted)` against `ROUTES`, not hand-maintained duplicated lists.
- [x] Preview opt-outs, if any, require a non-empty reason and are asserted against real surface names so stale opt-outs fail.
- [x] Mission Control visual evidence is captured from the preview route after implementation.

## Non-goals

- Redesigning Mission Control.
- Reworking the preview harness architecture.
- Replacing installed-extension dogfood. Preview is a fast visual gate, not a substitute for final installed-VSIX checks.
- Adding browser automation for every preview route.

## Open questions

- **Manifest-host guard shape:** should the host guard parse imports/usages from `src/extension.ts` or assert known converted host file patterns under `src/webview/*Panel.ts`? Lean: keep it small and explicit for the current panel-manager pattern.
- **Opt-out location:** keep preview opt-outs next to the test or export them from `routes.ts`? Lean: export from `routes.ts` so the preview contract lives beside `ROUTES`.
