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
- First installed reload used a content-different candidate that still declared `0.56.10`. The shell
  reattached, but the supervisor intentionally classified the running same-version engine as compatible
  and preserved its PID, so the new daemon routing was not active. Bumped package/lock to `0.56.11` for
  the real installed upgrade; this is required by the existing monotonic engine-upgrade contract.
- The maintainer reloaded `0.56.11`; headless inspection confirmed the main workspace moved to a new
  `tachyon-engine` process backed by bundle commit `ab70d683` and the Bridge reconnected successfully.
- Agent dogfood is headless. The persistent-engine runner now creates a disposable approval over the
  real agent-authenticated Bridge while zero shells are attached, reattaches a UI-capable Node shell,
  selects `Review`, asserts one exact-workspace `tachyon.openApprovals` command, and confirms the durable
  request remains pending. Any native Palette/panel inspection is performed by the maintainer.
- The persistent-engine fixture now exposes a fake `codex` executable instead of declaring `sleep` as
  an AI agent. This satisfies the current fail-closed Bridge-materialization contract while keeping the
  dogfood local, deterministic and free of an interactive/paid runtime process.

## Verification log

### 2026-07-16T16:09:11Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/daemonEngineHost.test.ts test/unit/cxApproval2Behavior.gen.test.ts test/unit/i18n.test.ts && npm run typecheck` — pass

### 2026-07-16T16:10:08Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/daemonEngineHost.test.ts test/unit/cxApproval2Behavior.gen.test.ts test/unit/i18n.test.ts && npm run typecheck` — pass
