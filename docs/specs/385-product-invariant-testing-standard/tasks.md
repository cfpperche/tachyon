# 385 — Product Invariant Testing Standard — tasks

_Generated from the ratified plan on 2026-07-14. Task: `t-2b8808`._

## Implementation

- [x] Write the normative Product Invariant standard, registry and `PI-001` metadata/governance.
- [x] Document the ratified author/reviewer/maintainer split: agents propose; an independent reviewer proves
      stable-promise RED/GREEN; a maintainer approves the promise; and the implementer cannot self-approve.
- [x] Document the policy-controlled equivalence exception for mechanical changes and require explicit maintainer
      approval for any weakening, removal or semantic/gate change.
- [x] Add the short Task/SDD affected-invariant convention and expose the standard through project guidance.
- [x] Register the project-guidance ownership boundary as `test/product-invariants/PI-001-*` and keep the
      shipping classifier in the ordinary regression suite.
- [x] Add Vitest discovery, `npm run test:invariants`, CI separation and developer documentation.
- [x] Extend `settings.verify` with explicit `affected` and `behavior` configuration plus JSON schema.
- [x] Make `cmd:` behavior gates stub-free and plain names require the configured Vitest-name adapter.
- [x] Bind named behavior verification to a pre-existing project-owned oracle; persist its SHA-256 and keep
      it outside the implementer's ownership scope.
- [x] Freeze the approved task, scope, verifier settings (including absence), oracle and executor snapshot at
      delegation creation and preserve it unchanged through fixer/reuse rounds.
- [x] Authenticate complete canonical Delivery and legacy delegation authority records with a workspace-bound,
      host-custodied HMAC-SHA-256 seal and a host-custodied current revision/MAC freshness head.
- [x] Make authority creation/mutation advance the freshness head before workspace commit and fail closed for
      missing keys/heads, tampering, rollback, stale records, identity/location mismatch or cross-workspace replay.
- [x] Run BASE/HEAD evidence in isolated tracked-only clones with hooks neutralized and ownership-safe cleanup.
- [x] Remove implicit npm full verification and Vitest affected-test execution from `verify_task`.
- [x] Make launch/preparation recovery preservation-only: never automatically remove or rewind a checkout
      after a fallible setup/launch step; use a Git lock as the per-attempt recovery receipt, refuse reuse
      while an incomplete receipt survives, and allow an already-finalized unlocked checkout to be reused.
- [x] Update the product-boundary registry and focused configuration/spawn/verification tests.
- [x] **Upgrade containment follow-up (`t-82f4e6`):** quarantine invalid or pre-hardening canonical Delivery
      rows individually during reload, keep their bound sessions unavailable, preserve the rows byte-for-byte,
      and allow independently valid signed Deliveries plus the rest of the workspace to start normally.

## Verification

- [x] The config/schema matrix accepts the complete explicit adapter and rejects incomplete/unsafe forms.
- [x] Gated spawn proves `cmd:` creates no stub, unconfigured names fail, and configured names bind only a
      clean tracked oracle without creating or owning it.
- [x] `verify_task` proves configured affected/behavior/full argv, exact-name enforcement, fail-before/pass-after,
      and honest missing-config blockers without invoking implicit npm/Vitest commands.
- [x] Verification proves the recorded oracle is byte-identical at BASE and HEAD, an explicit-empty settings
      snapshot cannot adopt later config, ignored worktree runners cannot supply evidence, and checkout hooks
      cannot mutate the isolated verification source.
- [x] Authority tests prove HMAC tamper/cross-workspace rejection, stale signed rollback rejection, durable head
      ordering/failure behavior, legacy location/freshness validation and immutable approved snapshot fields.
- [x] Consumer-boundary tests prove generic HMAC/freshness enforcement adds no implicit framework, command,
      invariant vocabulary or approval policy.
- [x] Launch fault-injection proves fresh/reused preparation is preserved across setup, launch and retry
      failures, including ignored or committed writes, with no automatic remove/reset race.
- [x] `PI-001` and the project-neutral global primer/init boundary pass through focused tests.
- [x] Typecheck, diff-check, focused suites and full verification pass.
- [x] Upgrade regressions prove an unsigned/tampered row is never trusted, never auto-signed or deleted, cannot
      make its bound session generically runnable, and cannot deny an unrelated valid signed Delivery or workspace.

**Headless check:** `npm run test:invariants && npm exec -- vitest run test/unit/config.test.ts test/unit/configSchema.test.ts test/unit/deliveryStore.test.ts test/unit/verifyTask.test.ts test/unit/workspaceHeadless.test.ts test/unit/snBoundaryLocksBehavior.gen.test.ts`

**Verify:** `npm run test:invariants`
**Verify:** `npm exec -- vitest run test/unit/config.test.ts test/unit/configSchema.test.ts test/unit/deliveryStore.test.ts test/unit/verifyTask.test.ts test/unit/workspaceHeadless.test.ts test/unit/snBoundaryLocksBehavior.gen.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run test:invariants`

The command is the project-owned semantic gate for the invariant suite. Installed-system
dogfood remains conditional per invariant metadata and is not required for portable component-topology
`PI-001`.

## Visual QA

**Visual QA Opt-Out:** no product UI or rendered interface changes; the observable surfaces are config,
generated test placement and deterministic command results.
