# 450 — Remove legacy agent format — tasks

_Generated from `plan.md` on 2026-07-25._

## Implementation

- [x] Extract migration-neutral canonical transaction primitives and update consumers.
- [x] Delete legacy migration planner/journal/recovery/rollback and installed rollout dogfood.
- [x] Remove migration extension commands and engine/runtime protocol operations.
- [x] Reject inline `agents:` declarations while preserving exact canonical pointers and terminals.
- [x] Remove legacy agent writer routes; retain canonical Agent Form lifecycle and terminal editing.
- [x] Update current architecture, command metadata, localization and configuration examples.
- [x] Retire exact installed migration residue and orphaned authority safely.
- [x] Add or update focused behavior and protocol tests.

## Verification

- [x] Inline agent rejection, canonical lifecycle recovery and terminal compatibility pass.
- [x] Typecheck and full verification pass on the task tree; repeat after integrating current `main`.

**Headless check:** `npm test -- test/unit/agentProfileConfigLoader.test.ts test/unit/agentProfileLifecycle.test.ts test/unit/agentProfileRename.test.ts test/unit/agentProfileForget.test.ts test/unit/workspaceHeadless.test.ts test/unit/engineServiceProtocol.test.ts test/unit/yamlEditor.test.ts`

**Verify:** `npm test -- test/unit/agentProfileConfigLoader.test.ts test/unit/agentProfileLifecycle.test.ts test/unit/agentProfileRename.test.ts test/unit/agentProfileForget.test.ts test/unit/workspaceHeadless.test.ts test/unit/engineServiceProtocol.test.ts test/unit/yamlEditor.test.ts`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm test -- test/unit/workspaceHeadless.test.ts -t "canonical"`

## Visual QA

**Visual QA Opt-Out:** Removal-only command/config surface; no new rendered interface is introduced.

## Cookbook

**Cookbook-Opt-Out:** No new operator surface; unsupported migration commands are removed.
