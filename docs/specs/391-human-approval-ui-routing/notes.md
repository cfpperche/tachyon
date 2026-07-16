# 391 — human-approval-ui-routing — notes

_Created 2026-07-16._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Baseline audit: the persistent-engine composition omitted the existing `onApprovalRequested` callback.
  The Bridge already writes the request, witness and pin before emitting `{ id, requester }`.
- Reuse `DaemonEngineHost.notify` and its replay path. Do not also present journaled notice events in the
  extension, which would duplicate the toast.
- Keep the notification to a `Review` doorbell. The panel re-reads the durable record for the captured
  workspace; no decision data or resolver is added to the event/Bridge.
- Contribute the already-registered `tachyon.openApprovals` command in English and pt-BR. Keep
  `tachyon.resolveApproval` internal.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

- The notice survives shell absence/disconnection within the current daemon process. It is not persisted
  across daemon replacement; the request itself is durable, and the Command Palette fallback remains the
  recovery path after a restart or dismissal.
- "Host-only" here retains the existing product meaning: no Bridge/MCP resolver. Same-UID private-socket
  hardening and concurrent resolve serialization are pre-existing concerns outside this routing fix.

## Open questions

None.

## Test log

- RED: `daemonEngineHost.test.ts` failed because `routeHumanApprovalRequest` did not exist; the manifest
  contract failed because `tachyon.openApprovals` was absent from `contributes.commands`.
- GREEN (focused): 3 files, 17 tests passed after wiring the callback and contributing/localizing the
  command.
- The initial worktree base (`02b00899`) failed typecheck in unrelated terminal mock assertions while
  current main (`0116df17`) passed. Rebase onto current main is required before final verification.
- Adversarial review found no routing/security/manifest defect. It did find that the behavior test called
  the routing helper directly, so a regression removing the `Workspace.createDaemon` callback would not
  fail. Added a focused composition assertion to close that gap.
- Full verification built successfully and completed 4,715 passing tests, 1 failure and 3 explicit skips.
  The only failure is the stale spec-389 `workspaceHeadless` expectation for legacy tmux `-L`; the exact
  focused test fails identically on main@`0116df17`. Updated existing bug `t-a0b115`; no unrelated file
  is included in this delivery.
- `t-a0b115` was fixed independently in one file and integrated to main as `bd48b86e`; its worktree and
  branch were removed. After rebasing this delivery, `npm run verify:full:quiet` passed: 412 files,
  4,717 tests passed and 3 explicit skips.

## Verification log

### 2026-07-16T16:09:11Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/daemonEngineHost.test.ts test/unit/cxApproval2Behavior.gen.test.ts test/unit/i18n.test.ts && npm run typecheck` — pass

### 2026-07-16T16:10:08Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/daemonEngineHost.test.ts test/unit/cxApproval2Behavior.gen.test.ts test/unit/i18n.test.ts && npm run typecheck` — pass
