# 346 — preview-catalog-coverage-guard — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Origin: spec 345 typography QA found Mission Control missing from the preview catalog even though it is a converted webview and rendered correctly in the installed VSIX.
- Discovery during planning: the existing `webviewPreviewCatalog.test.ts` already compares `WEBVIEW_SURFACES` to `ROUTES`; Mission Control escaped because it was also missing from `WEBVIEW_SURFACES`. The follow-up must guard manifest completeness, not only route completeness.
- Opus review: keep coverage in existing `webviewPreviewCatalog.test.ts`, add that file to the verify command, add Mission Control to `WEBVIEW_SURFACES`, assert the real `snapshotMessage` envelope, keep the Mission Control CSS order to codicon/design-system/panel CSS, and export an explicit opt-out map with no initial opt-outs.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

- 2026-07-03 — `npm test -- test/unit/webviewPreviewRoutes.test.ts test/unit/webviewPreviewCatalog.test.ts && npm run typecheck && npm run build` passed.

## Visual QA

- 2026-07-03 — Opened `http://localhost:5174/scripts/webview-preview/index.html?view=mission-control&fixture=default` with agent-browser. Screenshot saved to `/tmp/spec346-mission-control-preview.png`. Verdict: route renders Mission Control, validations, agent filter, dropped counter, and representative cards; no unknown-view fallback.
