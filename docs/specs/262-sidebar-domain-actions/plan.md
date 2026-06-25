# 262 — sidebar-domain-actions — plan

_Drafted from `spec.md` on 2026-06-25. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Extract a narrow `src/workspace/domainActions.ts` module for sidebar-visible domain mutations. The module should not import `vscode` and should not know about webviews; it receives a `Workspace` plus a small `onChanged(view)` callback dependency, mutates the workspace/domain state, and emits the view-change event through that callback. The VS Code shell adapts that callback to the existing `refreshAll`/`onViewsChanged` behavior.

Keep v1 deliberately small:

- Pins: `togglePinDone`, `deletePin`.
- Schedules/proposals: thin wrappers around existing `Workspace` domain methods (`toggleSchedulePause`, `deleteScheduleEntry`, `approveProposal`, `rejectProposal`) so sidebar and command handlers share the same action entry point.

Do not move confirmation dialogs, editor/terminal opens, clipboard writes, studio launches, command/runbook deletion, or pipeline/runbook/agent lifecycle operations into this layer. Those remain shell or follow-up scope.

## Files to touch

**Create:**
- `src/workspace/domainActions.ts` — shared mutation + refresh/event contract for v1 sidebar-visible domain actions.

**Modify:**
- `src/webview/SidebarPrototype.ts` — route `pin:toggle`, `pin:delete`, `schedule:pause`, `schedule:delete`, `proposal:approve`, and `proposal:reject` through `domainActions`; keep shell-only actions as-is.
- `src/extension.ts` — delegate matching command handlers (`tachyon.deletePinItem`, `tachyon.toggleSchedulePauseItem`, `tachyon.deleteScheduleItem`, `tachyon.approveProposalItem`, `tachyon.rejectProposalItem`) to `domainActions` after command-owned confirmation/input. `tachyon.addPin` can remain command-owned because it opens Pin Studio when no text is supplied.
- `test/unit/domainActions.test.ts` — direct domain action coverage for mutation, refresh callback, sibling preservation, and stale/missing entity behavior.
- `test/unit/sidebarPrototype.test.ts` — sidebar routing coverage that proves in-scope mutations no longer call VS Code commands and stale hashes are no-ops.
- Existing command-handler tests or a focused extension/unit test if available for command reuse; otherwise cover command reuse through `domainActions.test.ts` plus the existing command handler shape.

**Delete:**
- None expected.

## Alternatives considered

### Keep calling VS Code commands from the sidebar

Rejected for in-scope domain mutations because spec 261 showed a concrete stale-sidebar failure mode when a sidebar mutation depended on a shell command path for refresh.

### Move every command handler into the new layer

Rejected for v1 because many commands are shell orchestration, not domain mutation. A broad rewrite would raise regression risk without directly addressing the observed gap.

### Introduce an injected class/controller now

Rejected for v1 because the action surface is small and stateless. A module of pure functions plus an explicit `onChanged` dependency is enough to separate shell from domain behavior and is easier to test. A controller can be introduced later if action state or policy grows.

### Make `domainActions.ts` import or own VS Code refresh behavior

Rejected because it would move shell knowledge into the domain seam. The module should emit through an injected callback; the VS Code shell decides that `"pins"` means `sidebarProto.refresh()`, badges, status bar, or other UI work.

## Risks and unknowns

- Duplicate refresh is possible if a command handler keeps calling `refreshAll()` after delegating to an action that already emits `onChanged`; remove redundant refreshes in touched handlers.
- `deleteScheduleItem` still owns a confirmation modal. The command handler should keep the modal and call `deleteSchedule(...)` only after confirmation.
- `SidebarPrototypeProvider` currently has a private `push()` path. After pin mutations move to the domain event path, tests must prove the sidebar still receives the new fleet through the injected/adapted callback.
- Stale entity behavior should be explicit and quiet: deleting a missing pin/proposal/schedule should no-op or return `false`, not throw from the sidebar path.
- Pipeline/runbook/agent actions have asynchronous lifecycle semantics and remain out of scope unless implementation finds a direct v1 blocker.

## Research / citations

- `src/webview/SidebarPrototype.ts`
- `src/extension.ts`
- `src/workspace/Workspace.ts`
- `test/unit/sidebarPrototype.test.ts`
- `docs/specs/262-sidebar-domain-actions/debate.md`
