# 483 — governed Saved Agent proposal v2 — tasks

## Implementation

- [x] Extend proposal data, Bridge input and Human Inbox review.
- [x] Add the skew-safe v2 engine action and optional-owner lifecycle path.
- [x] Carry the narrow approved grant into the canonical profile.
- [x] Add/update focused tests for top-level ownership, selectors, grants and v2 wiring.
- [x] Reconcile comments and close the spec.

## Verification

- [x] Focused Saved Agent and lifecycle suites pass.
- [x] `npm run typecheck` passes.
- [x] `npm run verify:full:quiet` passes on the final committed tree.

**Headless check:** `npx vitest run test/unit/savedAgentProposal.test.ts test/unit/savedAgentProposalCommit.test.ts test/unit/savedAgentProposalReview.test.ts test/unit/agentProfileLifecycle.test.ts`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npx vitest run test/unit/savedAgentProposalCommit.test.ts test/unit/agentProfileLifecycle.test.ts`

## Visual QA

**Visual QA Opt-Out:** bounded data rows in an existing review layout; functional projection tests cover the values and the release is not blocked on desktop visual tooling.

## Cookbook

**Cookbook-Opt-Out:** the operator surface is the existing Human Inbox proposal flow; no new command or standalone workflow was added.
