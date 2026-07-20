# 419 — board-card-layout — tasks

_Generated from `plan.md` on 2026-07-20._

## Implementation

- [x] Split card markup into header badges, title body and footer controls without changing handlers.
- [x] Increase equal fixed column width to 300px and add responsive overflow-safe region styles.
- [x] Strengthen the preview fixture with distinct authors, long assignee and multiple badges.
- [x] Add a real-bundle headless browser regression for author visibility and corner placement.

## Verification

- [x] Focused browser test passes against the built Mission Control bundle.
- [x] Typecheck and full repository verification pass.
- [x] Headless desktop and narrow screenshots match the maintainer's layout anchor.

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run build && npx vitest run --config vitest.browser.config.ts test/browser/boardCardLayout.test.ts`

## Visual QA

- [x] Evidence: headless Board preview at 1440×900 and 900×900.
- [x] Verdict: concrete assessment against the maintainer's screenshots and corner-layout request.

## Cookbook

**Cookbook-Opt-Out:** presentation-only Board refinement; no new operator surface.
