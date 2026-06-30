# 302 — plugins-view-improvements — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- The per-card update check reuses the same update resolver as the global Check updates button. This keeps semver-tag/latest behavior identical and avoids a second policy.
- The per-card check is rendered only when `sourceSpec` exists. Local-dir installs get no dead/disabled control because there is no source to resolve.
- Filter/sort lives in `src/webview/plugins/listControls.ts`, a pure webview helper, so it is unit-testable and does not mutate `vm.installed`.
- The status sort puts actionable states first: update available, drift, conflict, error, unknown, then up-to-date.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- The dogfood command uses a purpose-built smoke script rather than `npm run preview:webview -- --once`; the preview server has no `--once` mode.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Version sorting is kept as a simple semantic-ish descending sort with name fallback. It is useful as an option but not the default because versions across different plugins are not directly comparable.
- The per-card `Check` action does not show a success toast; it updates the badge in place like the global check. This avoids noisy toasts when the result is already visible on the card.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

None for this slice.

## Validation log

- 2026-06-30 — `npm test -- --run test/unit/pluginsListControls.test.ts test/unit/pluginViewModel.test.ts test/unit/webviewPreviewPluginsFixture.test.ts` passed: 3 files, 27 tests.
- 2026-06-30 — `npm run -s typecheck` passed.
- 2026-06-30 — `npm run -s build` passed.
- 2026-06-30 — `bash docs/specs/302-plugins-view-improvements/smoke.sh` passed. It builds the webview, serves the preview harness, fetches the Plugins route and bundle, and verifies the new toolbar/check/no-results strings are present.
- 2026-06-30 — `agent-browser` doctor passed, then opened `http://localhost:5275/scripts/webview-preview/index.html?view=plugins&fixture=default`; snapshot found `Installed plugins controls`, `Filter installed plugins`, `Sort installed plugins`, and per-card `Check` buttons.
- 2026-06-30 — Screenshot evidence saved at `docs/specs/302-plugins-view-improvements/evidence/plugins-default.png`.

## Dogfood log

### 2026-06-30T17:30:00Z — pass — source: manual evidence
- `bash docs/specs/302-plugins-view-improvements/smoke.sh` — pass.
- `agent-browser` preview inspection and screenshot — pass.


### 2026-06-30T17:28:07Z — pass (1/1) — source: tasks.md — commit: 27031fd4b8a2aee785568233b492beed9bc15318
- `bash docs/specs/302-plugins-view-improvements/smoke.sh` — pass

## Verification log

### 2026-06-30T17:28:01Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/pluginsListControls.test.ts test/unit/pluginViewModel.test.ts test/unit/webviewPreviewPluginsFixture.test.ts && npm run -s typecheck && npm run -s build` — pass
