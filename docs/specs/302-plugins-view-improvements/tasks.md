# 302 — plugins-view-improvements — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add pure installed-plugin filter/sort helper and unit tests.
- [x] Add per-plugin update-check message/dispatch plumbing in the webview.
- [x] Refactor `PluginsPanelManager` update checking so global and single-plugin checks share one resolver and single-plugin checks merge into existing status.
- [x] Add sourced-only card "Check" action.
- [x] Add Installed toolbar with filter input, sort select, visible result count, and no-results state.
- [x] Update Plugins View CSS for toolbar and responsive action wrapping.
- [x] Dogfood the rendered Plugins View through the preview harness/screenshot path.
- [x] Close pin `p-014efe` after implementation, validation, dogfood, and clean `sdd-close`.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Per-plugin check update control appears for sourced installs and not for local installs.
- [x] Per-plugin check update updates one card status without clearing existing statuses for other cards.
- [x] Global Check updates still checks all sourced installed plugins.
- [x] Installed toolbar filters by plugin name/source/runtime/status text.
- [x] Installed toolbar sort changes render order without mutating the source VM.
- [x] Empty filtered state is visible when no installed plugins match.
- [x] Desktop preview renders without control/card overlap.

**Headless check:** `npm test -- --run test/unit/pluginsListControls.test.ts test/unit/pluginViewModel.test.ts test/unit/webviewPreviewPluginsFixture.test.ts && npm run -s typecheck && npm run -s build`
**Verify:** `npm test -- --run test/unit/pluginsListControls.test.ts test/unit/pluginViewModel.test.ts test/unit/webviewPreviewPluginsFixture.test.ts && npm run -s typecheck && npm run -s build`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `bash docs/specs/302-plugins-view-improvements/smoke.sh`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional — open Plugins View, check one plugin via its card, use the filter, switch sort modes, and confirm controls remain readable.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
