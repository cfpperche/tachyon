# 343 — activity-message-type-filters — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-07-03: Grouped `command` with chat because it is a human-entered prompt in the feed, while `tool`, `file`, `usage`, `error`, and `raw` stay under Tools. This keeps the v1 menu human-sized without exposing every internal render kind.
- 2026-07-03: Changed Activity item actions from a chevron icon to `kebab-vertical` so an actions menu is visually distinct from row expand/collapse chevrons.
- 2026-07-03: Moved "Copy share text" into the Activity item menu as a first-class action. "Share externally" now only handles external destinations, so copy no longer hides inside the external-share QuickPick.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- None.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- The menu prevents disabling the final visible category instead of allowing an empty feed. This avoids a confusing all-hidden state while still supporting targeted hiding and a Show all reset.

## Verification log

- 2026-07-03: `npm test -- test/unit/activityFeedModel.test.ts test/unit/webviewPreviewRoutes.test.ts && npm run typecheck && npm run build` passed.
- 2026-07-03: agent-browser preview at `http://127.0.0.1:5174/scripts/webview-preview/index.html?view=activity&fixture=default`; full-page screenshot saved at `/tmp/activity-filter-full.png`; snapshot included button "Filter visible activity types".
- 2026-07-03: `npm test -- test/unit/activityShare.test.ts test/unit/activityFeedModel.test.ts test/unit/webviewPreviewRoutes.test.ts && npm run typecheck && npm run build` passed after the Activity actions/share-menu UX refinement.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

### 2026-07-03T19:23:28Z — pass (1/1) — source: tasks.md
- `npm test -- test/unit/activityFeedModel.test.ts test/unit/webviewPreviewRoutes.test.ts && npm run typecheck && npm run build` — pass
