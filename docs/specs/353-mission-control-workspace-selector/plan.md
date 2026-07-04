# 353 — mission-control-workspace-selector — plan

_Drafted from `spec.md` on 2026-07-04. The approach, not the steps (those go in `tasks.md`)._

## Approach

Extend the Mission Control VM with a small list of available workspaces (`hash`, `folder`) produced by
`MissionControlPanelManager` from `getWorkspaces()`. The webview renders that list as a `KitSelect` beside the
Mission Control title, using the current `wsHash` as the selected value. The selector is always rendered; with one
workspace it has one option and stays visually quiet.

Add a `switchWorkspace` webview action. The host resolves the requested hash against the current workspace list,
updates the existing panel entry in place when no target panel is already open, posts a fresh snapshot, and updates
the editor tab title. If the requested workspace already has an open Mission Control panel, reveal that panel instead
of duplicating it.

## Key decisions

- **Always render the selector** — chosen because the maintainer wants Mission Control to keep the same visual
  structure between single-root and multi-root workspaces; rejected conditional text/dropdown because it changes the
  header shape as workspace count changes.
- **Switch in place when possible** — chosen because the header control should feel like changing the board scope,
  not like opening another unrelated command. Revealing an already-open target panel still avoids duplicate tabs.
- **Keep workspace metadata minimal** — the webview only needs display folder + hash; all task data remains in the
  selected workspace's snapshot.

## Files touched

- `src/webview/mission-control/messages.ts` — add workspace option data and `switchWorkspace` action.
- `src/webview/MissionControlPanel.ts` — populate workspace options and handle workspace switching.
- `src/webview/mission-control/App.tsx` — replace the plain folder suffix with a `KitSelect`.
- `src/webview/mission-control/mission-control.css` — tighten header selector styling if needed.
- `scripts/webview-preview/fixtures/mission-control.ts` and browser/unit tests — keep fixtures and coverage aligned.

## Risks & unknowns

- Switching a panel in place must update the `panels` map key, or a later open/dispose can leak stale entries.
- The selector must not widen the header enough to crowd Search on the existing narrow preview sizes.
- Existing single-workspace fixtures need workspace options or the webview can render an empty select.

## Visual impact

Visible surface: Mission Control's top-left header. Visual risk is the selector reading as too heavy or causing the
search/filter controls to shift. Proof: existing browser header parity test plus a preview screenshot if the local
preview harness is available after build.

## Sources consulted

- `src/webview/MissionControlPanel.ts` — current per-workspace panel map and snapshot posting.
- `src/webview/mission-control/App.tsx` — current header and existing `KitSelect` usage for agent filter.
- `src/webview/mission-control/messages.ts` — host/webview contract.
- `test/unit/missionControlPanel.test.ts` — host behavior coverage.
- `test/browser/boardHeaderKitParity.test.ts` — real-bundle header layout coverage.
