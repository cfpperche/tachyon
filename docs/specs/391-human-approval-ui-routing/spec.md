# 391 — human-approval-ui-routing

_Created 2026-07-16._

**Status:** shipped
**Closure:** Installed candidate `0.56.11` activated the persistent-engine wiring; focused tests pass
18/18 and packaged headless dogfood proves agent-authenticated request creation with no shell, retained
`Review`, exact-workspace `tachyon.openApprovals`, at-most-once execution and a still-pending durable
request. Current repository-wide baseline failures reproduce unchanged on main and are isolated in
`t-f5fb40` / `t-e1cf51`.
**Affected Product Invariants:** none — approval routing does not change the registered PI-001
project-guidance ownership promise or oracle.

**Verify:** `npx vitest run test/unit/daemonEngineHost.test.ts test/unit/cxApproval2Behavior.gen.test.ts test/unit/i18n.test.ts && npm run typecheck`
**Dogfood:** `node scripts/dogfood/run.mjs persistent-engine`

## Intent

The human-approval protocol, trusted panel, and host-only Approve/Deny resolver already exist.  During
the persistent-engine cutover, however, `Workspace.onApprovalRequested` stopped being wired to any shell
affordance.  A real request is persisted and pinned, but the maintainer receives no actionable route to
the panel; `tachyon.openApprovals` also remains an internal command absent from the Command Palette.

Done means a request created by the persistent engine produces a durable, actionable `Review`
notification in an attached shell (or after the next shell attaches), bound to the request's exact
workspace.  The Command Palette exposes the same panel as a localized fallback.  Choosing `Review`
opens the existing trusted panel; the human still makes the explicit Approve/Deny decision there, and
the requester confirms the durable result through `get_approval_status`.

## Acceptance criteria

- [x] **Scenario: an attached shell receives an actionable approval route**
  - **Given** an agent-authenticated requester records a pending human approval in the persistent engine
  - **When** an editor shell is attached
  - **Then** Tachyon presents a notification naming the request and requester with a `Review` action
  - **And** choosing `Review` opens the existing Human approvals panel for that exact workspace
- [x] **Scenario: a request survives shell absence without silent loss**
  - **Given** the persistent engine records an approval while no capable editor shell is attached
  - **When** a shell later attaches and UI requests are replayed
  - **Then** the pending actionable notification becomes visible without creating or resolving a second request
- [x] **Scenario: Command Palette provides a discoverable fallback**
  - **Given** Tachyon is installed with one or more configured workspaces
  - **When** the human runs `Tachyon: Open Human Approvals`
  - **Then** the existing workspace picker rules select the target and open its trusted approval panel
- [x] **Scenario: the human decision remains host-only and authoritative**
  - **Given** the panel displays a pending request's verbatim payload and provenance
  - **When** the human chooses Approve or Deny
  - **Then** the existing host resolver updates the durable request and the requester can observe that decision through `get_approval_status`
- [x] The contributed command has English and pt-BR titles, and no agent-facing approval resolver is added.

## Non-goals

- Changing which actions require human approval or automatically creating approval requests.
- Auto-approving, auto-denying, or auto-opening a panel without a human selecting `Review`.
- Treating pane text, `needs-input`, pins, or coordinator summaries as authorization.
- Redesigning the existing approval webview, changing its verbatim provenance contract, or adding mobile/OS push.
- Resolving the stale `a-0499c7` request; it remains historical evidence and must not be approved now.

## Open questions

None.  Reuse the existing durable daemon notice/action transport and the existing trusted panel.
