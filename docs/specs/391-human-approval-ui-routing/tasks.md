# 391 — human-approval-ui-routing — tasks

_Generated from `plan.md` on 2026-07-16. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add RED coverage for retained Review routing, exact workspace hash, at-most-once execution and
  Command Palette discoverability.
- [x] Wire `Workspace.onApprovalRequested` in the persistent-engine composition through the existing
  daemon notice/action transport.
- [x] Contribute and localize `tachyon.openApprovals` without exposing `tachyon.resolveApproval`.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] An attached shell receives request id/requester plus `Review`; no command runs before selection.
- [x] A no-shell request replays after attach and selecting `Review` executes exactly one
  `tachyon.openApprovals` command with the originating workspace hash.
- [x] Manifest and English/pt-BR catalogs expose `Tachyon: Open Human Approvals`; resolver remains
  absent from the contributed commands and Bridge tools.
- [x] Focused tests, typecheck and repository verification are green.

**Headless check:** `npx vitest run test/unit/daemonEngineHost.test.ts test/unit/cxApproval2Behavior.gen.test.ts test/unit/i18n.test.ts && npm run typecheck`
**Verify:** `npx vitest run test/unit/daemonEngineHost.test.ts test/unit/cxApproval2Behavior.gen.test.ts test/unit/i18n.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** The behavior crosses an installed VS Code shell notification and native Command
Palette; focused tests mechanically exercise the engine route, while the representative installed
surface is covered by the human walkthrough below.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** In the installed candidate, open `Tachyon: Open Human Approvals` from the Command
Palette and confirm the trusted panel opens. Create one disposable request while a shell is attached,
choose `Review`, and confirm the exact workspace panel shows it without resolving it. Repeat with the
shell absent, reattach/reload, and confirm the retained route appears. Do not approve stale
`a-0499c7`.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [ ] Evidence: Native screenshot of the localized Palette entry and the routed Human approvals panel.
- [ ] Verdict: Notification/action and Palette entry are legible, unambiguous and bound to the expected
  workspace; the unchanged panel preserves its existing layout.
