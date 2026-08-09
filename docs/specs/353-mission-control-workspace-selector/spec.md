# 353 — mission-control-workspace-selector

_Created 2026-07-04._

**Status:** shipped
**Closure:** Shipped locally: Mission Control now receives workspace options in its VM, renders an always-present Tachyon workspace selector in the header, and switches the panel workspace through a host action. Verification passed via `/sdd verify` on 2026-07-04.
**Verify:** `npm test -- test/unit/missionControlPanel.test.ts && npm run build && npm run test:browser -- test/browser/boardHeaderKitParity.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Intent

Mission Control is scoped to one Tachyon workspace folder, but the header currently renders that scope as plain text:
`Mission Control — <folder>`. In a multi-root VS Code window, command entry already asks which workspace to open,
but the board itself does not expose a stable workspace control.

Done means the Mission Control header always renders a Tachyon-owned workspace selector in that position, even when
there is only one available workspace. The one-workspace case keeps the same layout and control shape as multi-root,
so the view does not change appearance when a second project is added later.

## Acceptance criteria

- [x] **Scenario: single workspace keeps selector**
  - **Given** a VS Code window with one Tachyon workspace
  - **When** Mission Control opens
  - **Then** the header shows a workspace selector with that workspace selected, not a one-off plain text suffix.
- [x] **Scenario: multi-root can switch from the header**
  - **Given** a VS Code window with two Tachyon workspaces
  - **When** the user chooses the other workspace in the Mission Control header selector
  - **Then** the board switches to that workspace's task snapshot and the panel title follows the selected workspace.
- [x] The selector is visually quiet in the single-workspace case and does not compete with Search, agent filter, or the Task button.
- [x] Mission Control remains workspace-scoped; this spec does not create an aggregate cross-workspace board.

## Non-goals

- No aggregate/all-workspaces Mission Control board.
- No changes to VS Code editor tab labels or window titles.
- No changes to Plugins, Handoff, Task Studio, or the sidebar workspace grouping.

## Open questions

None. The maintainer chose a stable always-present selector over conditional text/dropdown UI.
