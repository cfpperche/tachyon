# 343 — activity-message-type-filters — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add pure Activity type-filter categories and helpers in `feedModel.ts`.
- [x] Add the Activity header filter button/menu with checkbox rows and show-all reset.
- [x] Combine type filtering with existing search and hidden-item count.
- [x] Persist filter state locally in the webview session.
- [x] Style the compact control/menu for the existing sticky header.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit tests cover category mapping, hidden count, search+type composition, and guard against disabling every category.
- [x] Typecheck and build pass.
- [x] Visual QA is recorded or explicitly opted out with reason.

**Headless check:** `npm test -- test/unit/activityFeedModel.test.ts test/unit/webviewPreviewRoutes.test.ts && npm run typecheck && npm run build`
**Verify:** `npm test -- test/unit/activityFeedModel.test.ts test/unit/webviewPreviewRoutes.test.ts && npm run typecheck && npm run build`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** The behavior is a webview-only UI filter covered by pure unit tests plus build/typecheck; meaningful dogfood is manual in the Activity panel.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Open an agent Activity panel, hide Tools, confirm tool/file/error/usage rows disappear while messages remain, search within the filtered feed, reset to Show all, and confirm hidden-count messaging is clear.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: agent-browser full-page preview screenshot saved at `/tmp/activity-filter-full.png`; accessibility snapshot exposed the "Filter visible activity types" button.
- [x] Verdict: Pass. The compact `Types` button fits in the existing Activity header without wrapping or overlapping the search/control area in the preview.
