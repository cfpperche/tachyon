# 426 — Agent profile migration — tasks

_Generated from `plan.md` on 2026-07-22._

## Contract

- [x] Declare PI-001 affected with promise/oracle unchanged.
- [x] Fix exact pointer syntax and inline-versus-profile exclusivity.
- [x] Define strict eligibility, deferred-field ownership and semantic equivalence.
- [x] Define durable transaction, authority, reconciliation, rollback and LKG behavior.
- [x] Keep plugins and later profile lanes out of scope.

## Implementation

- [x] Add strict synchronous profile-pointer source parsing.
- [x] Refactor config loading into source parsing plus trusted profile resolution.
- [x] Add host-custodied profile authority snapshots and startup loading.
- [x] Add the first measured native inspector/projector adapter.
- [x] Preserve one resolved `TachyonConfig`/`ManagedEntryDef` surface for existing consumers.
- [x] Extend LKG rows with profile provenance without granting spawn authority.
- [x] Add strict migration dry-run, eligibility and semantic-equivalence proof.
- [x] Add source-range YAML pointer replacement with outside-byte proof.
- [x] Add journaled commit/reconcile/rollback with CAS and no-follow path checks.
- [x] Add command-palette migrate/rollback operations and documentation.

## Verification

- [x] Legacy focused config tests remain unchanged and green.
- [x] Profile pointer plus trusted authority/attestation loads equivalently.
- [x] Mixed pointer/inline, path mismatch and double authority fail closed.
- [x] Unsupported fields/adapters/environment decisions write nothing.
- [x] Comments/settings/other agents remain byte-identical after migration.
- [x] Representative partial/complete crash tuples reconcile without overwrite.
- [x] Rollback refuses later profile/YAML/authority edits.
- [x] Warm/cold reload and LKG cannot activate stale profile authority.
- [x] PI-001 and plugin non-interference checks pass.
- [x] Typecheck and full verification pass.

**Headless check:** `npm test -- test/unit/agentProfileMigration.test.ts test/unit/config.test.ts test/unit/yamlEditor.test.ts test/unit/configFailure.test.ts test/unit/workspaceHeadless.test.ts`

**Verify:** `npm test -- test/unit/agentProfileMigration.test.ts test/unit/config.test.ts test/unit/yamlEditor.test.ts test/unit/configFailure.test.ts test/unit/workspaceHeadless.test.ts`

**Verify:** `npm run test:invariants`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileMigration.test.ts -t "dogfood: commits and rolls back an isolated profile fixture"`

## Visual QA

The command-palette flow uses native VS Code prompts only. Record the command names, dry-run summary and
confirmation/error messages during dogfood; no custom layout is introduced.

**Visual QA Opt-Out:** The operator surface uses native VS Code pickers and modal notifications only;
this slice introduces no custom layout or webview.

## Cookbook

**Cookbook:** yes
