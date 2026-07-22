# 433 — Live canonical profile rename — tasks

_Generated from `plan.md` on 2026-07-22._

## Design

- [x] Declare Affected Product Invariants before code.
- [x] Define durable versus ephemeral live bindings and replay pair states.

## Implementation

- [x] Add live snapshot and `live-converged` phase to the canonical rename journal.
- [x] Add atomic exact SessionLedger rename and child-reference rewrite.
- [x] Add pair-state activity-file convergence that preserves concurrent appends.
- [x] Add AgentManager prepare/converge methods with tmux replay and runtime refusals.
- [x] Route running profile-backed rename and rederive Workspace presentation caches.

## Verification

- [x] Focused tests cover running/stopped, tmux acknowledgement loss and destination collision.
- [x] Crash/retry coverage spans tmux, ledger, activity and activation boundaries.
- [x] Harness and Pi refuse before persistent mutation.
- [x] Full configured verification and typecheck pass (474 files; 5428 passed, 3 skipped).

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npx vitest run test/unit/logStore.test.ts test/unit/resume.test.ts test/unit/agentManager.test.ts test/unit/agentProfileRename.test.ts test/unit/workspaceHeadless.test.ts`

## Visual QA

**Visual QA Opt-Out:** no new visual surface; terminal reattachment is covered through the presentation seam.

## Cookbook

**Cookbook-Opt-Out:** internal rename lifecycle; operator UX remains owned by `t-149877`.
