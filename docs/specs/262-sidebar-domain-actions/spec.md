# 262 — sidebar-domain-actions

_Created 2026-06-25._

**Status:** shipped

**Closure:** shipped 2026-06-29 — added the narrow `src/workspace/domainActions.ts` shared action layer and rewired
sidebar-visible domain mutations through it. Sidebar pin toggle/delete no longer mutate stores inline; schedule
pause/delete and proposal approve/reject no longer route through VS Code command bus for the actual mutation. Matching
VS Code command handlers now delegate to the same action layer after keeping their shell-owned confirmations. Claude
review found two real regressions in the first pass (sidebar schedule delete and proposal reject had bypassed modal
confirmation); both were folded by moving those confirmations into the sidebar shell before calling `domainActions`.
Verified with focused domain/sidebar tests, typecheck, full suite, build, and `git diff --check`.

**UI impact:** none

## Intent

The Preact sidebar is now Tachyon's primary workspace surface, but several sidebar row actions still call VS Code command handlers that were originally shaped around command palette/tree item entry points. That reuse is convenient, but it blurs the shell/engine boundary: a sidebar-originated domain mutation can depend on another shell command to mutate state and refresh the sidebar. Spec 261's pin-delete drift exposed the concrete risk. Introduce a small shared domain-action layer for sidebar-visible workspace mutations so both the VS Code command shell and the sidebar host call one mutation + refresh/event contract, while UI-only actions continue to live in the shell.

## Acceptance criteria

- [x] **Scenario: Sidebar mutates pins without command-bus indirection**
  - **Given** the sidebar sends a pin mutation such as toggle or delete for a row in a specific workspace
  - **When** the host handles that message
  - **Then** the mutation runs through a shared domain action and emits the same domain refresh path used by non-sidebar callers, so the next sidebar fleet payload reflects the new pin state without requiring a VS Code window reload.

- [x] **Scenario: Pin delete preserves sibling pin state**
  - **Given** a workspace has multiple pins in a stable order
  - **When** the sidebar deletes one pin through the shared domain action
  - **Then** only the targeted pin disappears, sibling pins remain present and in order, and the fleet payload does not briefly republish the deleted pin.

- [x] **Scenario: VS Code commands use the same mutation contract**
  - **Given** a user invokes an equivalent command handler from the command palette, an editor command, or a non-sidebar extension entry point
  - **When** the command performs an in-scope workspace mutation
  - **Then** it calls the same shared action used by the sidebar instead of duplicating mutation and refresh/event behavior.

- [x] **Scenario: Schedules and proposals preserve engine-owned refresh**
  - **Given** the sidebar approves/rejects a schedule proposal or pauses/deletes a schedule
  - **When** the action mutates schedule state or `tachyon.yml`
  - **Then** the mutation remains owned by the workspace/domain layer, emits the existing `onViewsChanged("schedules")` path, and the sidebar updates through that event.

- [x] **Scenario: Shell-only actions remain shell-only**
  - **Given** a sidebar action only opens UI, reveals a file/terminal, copies clipboard text, or launches a studio panel, such as `command:open` or `pin:copy`
  - **When** the action is handled
  - **Then** it may continue to call VS Code APIs or command handlers directly and is not forced into the domain-action layer.

- [x] **Scenario: Multi-root targeting is preserved**
  - **Given** multiple Tachyon workspaces are visible in the sidebar
  - **When** a sidebar action includes a workspace hash
  - **Then** the shared action operates only on the targeted workspace, and a stale or unmatched hash is a no-op with no mutation in workspace zero.

- [x] Unit coverage documents the boundary: at least one test for direct sidebar mutation, at least one test for command-handler reuse of the shared action, and at least one test proving a UI-only action is still allowed to stay in the shell.

## Non-goals

- No rewrite of every Tachyon command handler.
- No command/runbook delete extraction in v1; those confirmation-bearing config edits are follow-up scope.
- No removal or renaming of public VS Code commands.
- No Bridge/MCP tool contract changes.
- No Pin Studio, Activity, Handoff, Plugins, or Probes panel rewrites.
- No new sidebar visual layout or affordance changes.
- No broad `Workspace` refactor beyond extracting the action seam needed by this spec.
- No attempt to make long-running pipeline/runbook/agent lifecycle operations synchronous in the sidebar.

## Open questions

- [x] Shared layer shape: use a narrow `src/workspace/domainActions.ts` module, not a broad controller. The module receives a workspace plus a refresh callback dependency so shells can adapt refresh without the domain action importing VS Code.
- [x] Pin refresh contract: pin actions call the shared module, mutate `pinStore`, and trigger the supplied `onChanged("pins")` callback. In the VS Code shell that callback is wired to the existing sidebar/badge refresh path.

## Context / references

- `docs/specs/261-sidebar-pin-preview/` — pin preview work surfaced the sidebar as the active pin workflow.
- `src/webview/SidebarPrototype.ts` — current webview host routes sidebar messages to a mix of direct store calls and `vscode.commands.executeCommand`.
- `src/extension.ts` — current command handlers own many shell concerns and some mutation/refresh behavior.
- `src/workspace/Workspace.ts` — schedules/proposals/pipeline lifecycle already expose domain-level mutation paths that emit `deps.onViewsChanged(...)`.
- `test/unit/sidebarPrototype.test.ts` — existing coverage for sidebar fleet repush, pin copy, pin preview routing, and the pin delete refresh fix.
- Claude review captured in `debate.md` — recommended `SHIP-WITH-CHANGES`, v1 limited to pins plus schedules/proposals, and a workspace-owned domain seam rather than a sidebar-owned one.
