# 200 — tachyon-runbooks — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. Config: `RunbookDef` + `runbooks:` parsing + JSON schema
- [x] 2. `RunbookRunner` (sequential, exit-code gate, postmortem keep, history cap 10) + unit tests
- [x] 3. Bridge: `run_runbook` (await ≤ timeout, progress on re-call, rerun param)
- [x] 4. Sidebar: Runbooks group with expandable per-step items (✓/✗/skipped, failed step opens pane)
- [x] 5. extension.ts wiring (toasts, `_runRunbook`/`_runbooks` seams, stopAll)
- [x] 6. deleteCommand → runbook-reference warning
- [x] 7. Integration (ship passes; doomed gates at step 2, pane kept, step 3 skipped) + live claude E2E

## Verification

**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`

- [x] Unit 153/153 (runbooks 6/6 within)
- [x] xvfb integration: ship → passed/passed, panes tidied; doomed → passed/failed(7)/skipped, `tachyon-rb-*-doomed-1` kept
- [x] Live claude -p E2E: run_runbook ship → outcome passed, both steps reported with exit 0

## Notes

Step sessions sweep leftovers of the previous job of the SAME runbook at start —
keeps ✗ postmortems readable until the next attempt, then replaces them.
