# 346 — preview-catalog-coverage-guard — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add a typed Mission Control preview fixture.
- [x] Add Mission Control to `WEBVIEW_SURFACES`.
- [x] Add `mission-control` to `ROUTES` with CSS order matching `MissionControlPanel.ts`.
- [x] Add Mission Control `VIEW_META` title and aliases.
- [x] Export an explicit preview opt-out map from the preview routes module.
- [x] Add a unit guard that catches known converted webview hosts missing from `WEBVIEW_SURFACES`.
- [x] Add or extend the unit guard comparing converted `WEBVIEW_SURFACES` to `ROUTES` plus opt-outs.
- [x] Regenerate `scripts/webview-preview/routes.json`.
- [x] Capture Mission Control preview screenshot evidence.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Mission Control route renders in preview.
- [x] Catalog contains `mission-control`.
- [x] Coverage guard fails missing converted webviews.
- [x] Manifest guard fails converted webview hosts missing from `WEBVIEW_SURFACES`.
- [x] Existing preview route tests remain green.

**Headless check:** `npm test -- test/unit/webviewPreviewRoutes.test.ts test/unit/webviewPreviewCatalog.test.ts && npm run typecheck && npm run build`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npm test -- test/unit/webviewPreviewRoutes.test.ts test/unit/webviewPreviewCatalog.test.ts && npm run typecheck && npm run build`

## Dogfood

**Dogfood:** `npm run preview:webview`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** open `http://localhost:<preview-port>/scripts/webview-preview/index.html?view=mission-control&fixture=default` and confirm the board renders with representative cards/validations.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: `/tmp/spec346-mission-control-preview.png`.
- [x] Verdict: route renders without unknown-view fallback and shows a representative board.
