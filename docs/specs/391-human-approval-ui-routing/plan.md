# 391 — human-approval-ui-routing — plan

_Drafted from `spec.md` on 2026-07-16. The approach, not the steps (those go in `tasks.md`)._

## Approach

Reconnect the existing `Workspace.onApprovalRequested` composition seam in the persistent engine.
The callback creates one retained daemon notice containing a `Review` action. The action sends the
existing typed `execute-command` UI request for `tachyon.openApprovals`, bound to the originating
workspace hash. The editor shell already presents daemon notices and dispatches typed commands, so
the extension event loop and approval panel need no new protocol or handler.

Contribute the already-registered `tachyon.openApprovals` command to the extension manifest and add
English and pt-BR titles. Keep `tachyon.resolveApproval` internal. Cover the missing composition with
a focused behavior test that exercises shell absence, replay, selection, exact-workspace routing and
at-most-once action execution; cover manifest discoverability with structural assertions.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Reuse the daemon notice/action transport** — it already retains an unclaimed action while no shell
  is attached and replays it on attach; rejected a new engine event or extension listener because that
  would duplicate the existing `notice.present` route.
- **The toast is a doorbell, not an approval control** — `Review` only opens the trusted panel for the
  captured workspace hash; rejected Approve/Deny actions and automatic panel opening because the panel
  must re-read the durable verbatim request before a human decides.
- **Contribute only `tachyon.openApprovals`** — it is the safe, read/review fallback; keep
  `tachyon.resolveApproval` uncontributed and keep every resolver absent from the Bridge.
- **Do not redesign the panel** — the regression is routing/discoverability, and the existing panel
  already owns workspace binding, provenance display and resolution.

## Files touched

- `src/engine-service/engineService.ts` — wire the approval callback and its retained Review action.
- `package.json` — contribute the existing open-approvals command to the Command Palette.
- `package-lock.json` — keep the packaged engine version aligned for the installed upgrade candidate.
- `package.nls.json` — English command title.
- `package.nls.pt-br.json` — pt-BR command title.
- `test/unit/daemonEngineHost.test.ts` — behavioral replay and exact-workspace routing coverage.
- `test/unit/cxApproval2Behavior.gen.test.ts` — manifest/localization and resolver-boundary coverage.
- `docs/specs/391-human-approval-ui-routing/*` — delivery contract and evidence.

## Risks & unknowns

- A second listener for journaled notice events would show duplicate notifications; only the existing UI
  broker path may present the notice.
- The action must capture `workspace.wsHash`; falling back to the first workspace would misroute a
  multi-root decision.
- A notice is retained across shell absence/disconnection, not across daemon process replacement. The
  approval record itself remains durable and the contributed command is the recovery route after a
  restart or dismissal.
- The current "host-only" boundary means no Bridge/MCP resolver and an internal UI command. Stronger
  same-UID process isolation on the private daemon socket is a separate security boundary, not widened
  or claimed by this change.
- The installed extension must be reloaded before native dogfood can see a newly contributed command.
- A content-different engine bundle with the same semantic version is deliberately reused as compatible;
  installed dogfood therefore needs a monotonic package/engine version.

## Visual impact

Two native VS Code affordances change: a new actionable information notification and a new localized
Command Palette entry. The existing Human approvals panel is unchanged. Installed-extension dogfood
will inspect the Palette entry and the `Review` route into the correct panel; native screenshots record
the visible result.

## Sources consulted

- `src/bridge/tools.ts` — persistence happens before `onApprovalRequested` is emitted.
- `src/workspace/Workspace.ts` — existing callback seam and pins refresh event.
- `src/workspace/DaemonEngineHost.ts` — retained notices, replay and single-consumption actions.
- `src/engine-service/controlServer.ts` and `src/shell/WorkspaceClient.ts` — single-shell UI broker.
- `src/extension.ts` — existing notice handler, `tachyon.openApprovals` handler and approval-panel refresh.
- `docs/specs/382-persistent-engine/` — shell-independent engine and typed UI request contract.
- `docs/specs/391-human-approval-ui-routing/spec.md` — acceptance contract.
