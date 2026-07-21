# 419 — board-card-layout — plan

_Drafted from the ratified `spec.md` on 2026-07-20._

## Approach

Keep `Task` and `BoardCardVM` unchanged: the projection already carries a non-empty author. Replace
the single clipping metadata row in `Card` with a header/body/footer layout. The header reserves a
shrinking text slot for author and a right-aligned wrapping badge group; the footer reserves task id
and the existing interactive assignee/priority controls independently. Increase the fixed equal
column width from 260px to 300px and retain Board-level horizontal overflow.

Add a browser test against the real built Mission Control bundle. Its fixture uses long author and
assignee strings plus multiple badges, then measures bounding rectangles to prove author/badges and
id/controls occupy opposite sides without overlap. Use the preview harness for headless screenshots
at a desktop viewport and a narrower viewport.

## Key decisions

- **Presentation-only fix** — `TaskStore` bounds/defaults author and `buildBoardModel` always projects
  it; changing data would conceal the actual CSS clipping cause.
- **300px equal fixed lanes** — a modest 15% increase improves title/metadata breathing room while
  preserving predictable lane widths and horizontal navigation; rejected content-sized lanes
  because long titles would make columns unequal.
- **Badges may wrap within the upper-right region** — preserves every status signal instead of
  clipping it; the author retains its own independent slot.
- **Keep the assignee dot** — the maintainer explicitly removed the author dot only; assignee color
  remains a useful identity cue on the editable control.

## Files touched

- `src/webview/mission-control/App.tsx` — card region markup, existing handlers preserved.
- `src/webview/mission-control/mission-control.css` — wider lanes and four-region layout.
- `scripts/webview-preview/fixtures/mission-control.ts` — varied authors and stress metadata.
- `test/browser/boardCardLayout.test.ts` — real-bundle positional/visibility regression.
- `docs/specs/419-board-card-layout/*` — contract, evidence and closure.

## Risks & unknowns

- Too many badges could crowd the author; mitigate with independent slots and wrapped badge group.
- Narrow viewports must scroll the Board, not squeeze lanes; assert fixed width and overflow.
- Interactive editors could expand the footer; preserve event propagation boundaries and allow the
  right group to take available width without overlapping the id.

## Visual impact

Anchor: maintainer screenshots from 2026-07-20. Judge column breathing room, corner alignment,
author visibility without a dot, badge grouping, title rhythm, footer separation and narrow-width
horizontal behavior. Capture headlessly through the webview preview harness.

## Sources consulted

- Maintainer screenshots and layout instructions in `t-57e60b`.
- `src/webview/mission-control/App.tsx` and `mission-control.css`.
- `src/tasks/boardModel.ts` and `src/tasks/TaskStore.ts`.
- `scripts/webview-preview/fixtures/mission-control.ts`.
- SDD 384 and the existing Board browser-test pattern.
