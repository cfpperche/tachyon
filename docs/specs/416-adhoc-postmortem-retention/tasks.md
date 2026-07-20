# 416 — adhoc-postmortem-retention — tasks

_Generated from `plan.md` on 2026-07-19._

## Implementation

- [x] Add and defensively parse the `clean-exited` session lifecycle marker.
- [x] Persist the marker before completing clean-pane removal; stop deleting clean-exit rows during `list()`.
- [x] Rehydrate the terminal row and exclude it from activation resume planning.
- [x] Clear terminal state on explicit new incarnation and preserve existing explicit-dismiss cleanup.
- [x] Persist the authenticated delegator as managed worktree creator and retain it across sync.
- [x] Add regression tests for reconstruction, malformed state, no-resume, explicit dismiss and coordinator-only cleanup.

## Verification

- [x] A real ledger → clean exit → reconstructed manager round trip keeps one readable postmortem row.
- [x] Resume planner and legacy compatibility tests pass.
- [x] Coordinator/peer managed-worktree authorization tests pass with occupancy and dirty guards unchanged.
- [x] Full verification and typecheck pass.

**Headless check:** `npx vitest run test/unit/agentManager.test.ts test/unit/bridge.test.ts test/unit/resume.test.ts test/unit/managedWorktree.test.ts --maxWorkers=1`

**Verify:** `npx vitest run test/unit/agentManager.test.ts test/unit/bridge.test.ts test/unit/resume.test.ts test/unit/managedWorktree.test.ts --maxWorkers=1`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentManager.test.ts test/unit/managedWorktree.test.ts -t "postmortem across manager reload|coordinator retains authority" --maxWorkers=1`

## Visual QA

**Visual QA Opt-Out:** no new layout or styling; this preserves an existing postmortem row across engine reconstruction and is exercised through the headless Bridge projection.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface; existing `list_agents`, `read_output`, `dismiss_agent` and `remove_worktree` semantics become reliable.
