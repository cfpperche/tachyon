# 343 — activity-message-type-filters — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep filtering entirely in the Activity webview. The durable log remains a complete audit trail; the view applies filters after the existing loaded-window search index is built.

Add a pure category layer in `src/webview/activity/feedModel.ts`:

- define the fixed UI categories (`chat`, `tools`, `system`, `thinking`, `media`);
- map every `ActivityItem.kind` to one category;
- expose helpers to compute a visible category set, filter items by category, and count hidden items.

In `src/webview/activity/App.tsx`, add a compact "Types" control in the sticky header. It opens a small checkbox menu with one row per category, a hidden-item count, and a reset/show-all action. The filter runs after text search, so visible results satisfy both the query and enabled categories. Persist the enabled category set in `localStorage` so reopening the Activity webview in the same VS Code session keeps the user's preference.

## Key decisions

- **View-only filtering** — chosen because the user asked to hide/show visible messages, not mutate history; rejected log pruning because Activity must remain an audit trail.
- **Small categories, not every internal kind** — chosen because a dozen checkboxes is noisy; rejected raw-kind toggles as too implementation-shaped for a human panel.
- **Search first, category second** — chosen because the search box says it searches recent loaded activity; category filters then refine those results.
- **Local persistence only** — chosen because this is a UI preference, not project state; rejected a Tachyon setting for v1.

## Files touched

- `src/webview/activity/feedModel.ts` — pure category definitions and filter helpers.
- `src/webview/activity/App.tsx` — header type-filter control and filtered render path.
- `src/webview/activity/activity.css` — compact menu styling.
- `test/unit/activityFeedModel.test.ts` — category mapping/filter tests.
- `docs/specs/343-activity-message-type-filters/*` — this spec.

## Risks & unknowns

- The header is already dense; the filter control must stay compact and avoid wrapping awkwardly.
- Hidden day separators must not appear without visible items; filter before `withDaySeparators`.
- Hiding all categories should be prevented or handled clearly. Prefer a reset/show-all affordance and keep at least one category enabled.
- Type filters should not hide the working/needs-input live state indicators when no search is active; those are panel state, not log items.

## Visual impact

Activity header gains a compact "Types" filter button/menu. Visual risks: crowded sticky header, menu overflow on narrow panels, and unclear hidden-item state. Verify through the existing webview preview/build and record manual inspection notes if live preview is available.

## Sources consulted

- Pin `p-521c54`.
- `src/activity/activityView.ts` — existing `ActivityItem.kind` taxonomy.
- `src/webview/activity/App.tsx` — current search and render pipeline.
- `src/webview/activity/feedModel.ts` — existing pure search/tail helpers.
- `src/webview/activity/activity.css` — header/search styling.
- Specs 238, 323, and 324 for Activity view/history/share context.
