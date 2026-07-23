# 432 — Canonical profile rename — tasks

_Generated from `plan.md` on 2026-07-22._

## Design

- [x] Declare Affected Product Invariants before code.
- [x] Define the irreversible commit point and every recovery direction.
- [x] Obtain independent review of authority replay, Evolution composition and two-name blocking.

## Implementation

- [x] Add normalized ordered locks and idempotent authority compare-and-move.
- [x] Implement no-follow directory move, journal, compensation and roll-forward recovery.
- [x] Implement affected-locator rename preserving unrelated config edits.
- [x] Add shared both-name launch/reuse blocking and startup reconciliation.
- [x] Route stopped profile-backed Workspace rename while preserving legacy behavior.

## Verification

- [x] Focused tests cover success, stale/collision and exact identity preservation.
- [x] Pre-commit compensation and post-commit roll-forward recovery are covered.
- [x] Ordered name locking and authority acknowledgement loss are covered.
- [x] Evolution present and destination-conflict states are covered; absent and replay states share the same pair-state kernel.
- [x] Full configured verification and typecheck pass (474 files; 5422 passed, 3 skipped).

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileRename.test.ts test/unit/workspaceHeadless.test.ts`

## Visual QA

**Visual QA Opt-Out:** no visual surface changes in the stopped rename kernel.

## Cookbook

**Cookbook-Opt-Out:** internal lifecycle operation; operator UX ships in `t-149877`.
