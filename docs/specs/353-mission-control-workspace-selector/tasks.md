# 353 — mission-control-workspace-selector — tasks

_Generated from `plan.md` on 2026-07-04. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add workspace selector data + `switchWorkspace` action to the Mission Control message contract.
- [x] Populate workspace options and implement host-side workspace switching without duplicate panels.
- [x] Render an always-present `KitSelect` in the Mission Control header.
- [x] Update preview fixtures and focused tests for single-root and multi-root behavior.

## Verification

- [x] Single-root snapshot renders a selected workspace option instead of relying on plain suffix text.
- [x] Multi-root switch action changes the panel's workspace snapshot/title in place when no target panel is open.
- [x] Existing board interactions still route through the selected workspace.

**Headless check:** `npm test -- test/unit/missionControlPanel.test.ts && npm run build && npm run test:browser -- test/browser/boardHeaderKitParity.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`
**Verify:** `npm test -- test/unit/missionControlPanel.test.ts && npm run build && npm run test:browser -- test/browser/boardHeaderKitParity.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood-Opt-Out:** Real multi-root VS Code switching is best confirmed in the installed extension; the headless unit test covers the host state transition and the browser test covers the rendered header.

**Human dogfood:** Open Mission Control in a single Tachyon workspace and confirm the header shows a quiet selected workspace control. In a multi-root window, choose another workspace from that control and confirm the board changes scope.

## Visual QA

- [x] Evidence: `test/browser/boardHeaderKitParity.test.ts` drives the real `dist/webview/mission-control.js` bundle and verifies the workspace selector aligns with Search, agent filter, and buttons.
- [x] Verdict: PASS via `/sdd verify` on 2026-07-04.
