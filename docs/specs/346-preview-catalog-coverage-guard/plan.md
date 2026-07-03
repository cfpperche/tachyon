# 346 — preview-catalog-coverage-guard — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add Mission Control to the manifest and preview harness the same way Task Detail and Task Studio were added: `WEBVIEW_SURFACES` entry, typed fixture, shared message constructor, route entry, view metadata, generated catalog, tests, and visual evidence.

Then add coverage guards for both gaps. First, assert known converted webview host files that follow the panel/view pattern are present in `WEBVIEW_SURFACES`. Second, import `WEBVIEW_SURFACES` and `ROUTES`, compute the set of converted surfaces, and assert each one is either present in `ROUTES` or explicitly opted out with a reason. The existing catalog test covers the second layer; it did not catch Mission Control because the manifest layer was incomplete.

## Key decisions

- **Use `WEBVIEW_SURFACES` as the source of truth** — chosen because it is already the canonical manifest for converted webviews; rejected a separate preview-required list because it would drift.
- **Guard the manifest itself** — chosen because a route coverage test cannot catch panels that never reached `WEBVIEW_SURFACES`; rejected relying on code review because Mission Control already slipped through.
- **Put preview opt-outs beside `ROUTES`** — chosen so route coverage policy lives in the preview module; rejected hiding opt-outs only inside a test because maintainers adding a route would not naturally see the exception list.
- **Use a synthetic typed Mission Control fixture** — chosen because Mission Control's visual surface depends on a `BoardSnapshot`, not live disk state; rejected capturing a host VM because the route only needs representative columns/cards/validations.
- **Fail stale opt-outs** — chosen because an opt-out for a removed/renamed surface otherwise becomes misleading debt.

## Files touched

- `src/webview/surfaces.ts` — add Mission Control and, if needed, update manifest comments.
- `scripts/webview-preview/fixtures/mission-control.ts` — new typed Mission Control fixture.
- `scripts/webview-preview/routes.ts` — import Mission Control envelope/fixture, add `mission-control` route, view metadata, and preview opt-out export.
- `scripts/webview-preview/routes.json` — regenerate catalog.
- `test/unit/webviewPreviewCatalog.test.ts` — assert manifest host coverage, converted-surface route coverage, opt-out validity, and catalog parity.
- `test/unit/webviewPreviewRoutes.test.ts` — assert Mission Control route shape.
- `docs/specs/346-preview-catalog-coverage-guard/*` — spec record and verification evidence.

## Risks & unknowns

- A manifest host guard can become brittle if it tries to infer every future webview host pattern. Keep it scoped to current converted panel/view hosts and make failures readable.
- Mission Control expects enough snapshot structure to render validations, chips, allowed drops, and columns. The fixture must cover representative cards without relying on disk.
- The coverage guard must not force dev-only or intentionally non-previewable surfaces into the catalog without an opt-out path.
- `routes.json` can drift if regenerated incorrectly; existing catalog tests should catch this.

## Visual impact

The only visible change is that Mission Control becomes available in the preview harness/catalog. Capture `/tmp` screenshot evidence from the `mission-control` preview route after implementation.

## Sources consulted

- `src/webview/surfaces.ts` — converted surface manifest and existing claim that the preview harness spans it.
- `src/webview/MissionControlPanel.ts` — real host that was missing from the manifest.
- `scripts/webview-preview/routes.ts` — route table, view metadata, catalog generation.
- `src/webview/mission-control/messages.ts` — `snapshotMessage` envelope for preview injection.
- `src/webview/mission-control/App.tsx` — rendering expectations for a representative `BoardSnapshot`.
- `src/tasks/boardSnapshot.ts` and `src/tasks/types.ts` — fixture shape.
- `test/unit/webviewPreviewRoutes.test.ts` — existing route assertions.
