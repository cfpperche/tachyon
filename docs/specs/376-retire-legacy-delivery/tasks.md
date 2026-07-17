# 376 — retire-legacy-delivery — tasks

_Generated from `plan.md` on 2026-07-13. This is a bounded retirement, not continuation of spec 368._

## Implementation

- [x] **T1 — Freeze the canonical-only contract and state-retirement fixture.** Capture current canonical
  spawn/join/verify/projection behavior plus a temp-workspace fixture containing delegation files, unlinked and
  linked GitDelivery rows, canonical Deliveries, old mirrors, Git refs, and dirty/clean worktrees. Prove the
  retirement preview is stable and performs no mutation.
- [x] **T2 — Remove product selection and old public entry points.** Delete `settings.delivery`, obsolete
  GitDelivery profile knobs, `reuse_worktree`, `verify_task.agent`, `git_delivery_open`, and standalone auto-open;
  wire canonical mechanism-only unconditionally and return an exact gated-spawn Delivery receipt.
- [x] **T3 — Remove legacy models and verifier adaptation.** Refactor verification and primer/re-anchor to consume
  Delivery contract/segments directly; delete DelegationRecord, reuseWorktree, legacyImport, import reservations,
  and their tests/callers.
- [x] **T4 — Enforce projection-only GitDelivery.** Require immutable `deliveryId`, route all creation/mutation
  through DeliveryProjectionService, remove generic/unlinked branches and obsolete JSON promotion/mirror code,
  while retaining incomplete-canonical reconciliation as an unavailable crash state.
- [x] **T5 — Ship the explicit retirement action.** Implement preview + confirmed archive/apply with digest,
  idempotent replay, partial-state refusal, zero Git mutation, and a single actionable pre-retirement diagnostic.
  Run it against a copy of the current workspace state before asking the maintainer to apply it to the real state.
- [x] **T6 — Update current surfaces and dogfood.** Remove obsolete config from `tachyon.yml`, update current docs,
  schemas/tool counts/descriptions, build/install the candidate, and run one real optimal implement -> verify ->
  review FINDINGS -> fix -> verify -> ACCEPT lifecycle on a single Delivery/worktree.
  - Installed `0.56.17` completed the lifecycle on Delivery `d-spawn-ad0abeeaf7e8e2be0cb759ef18ddce8c`
    in one worktree. The final reviewed HEAD is `907499fb`; both canonical verification rounds accepted without
    waiver or quarantine, and the real-worktree full gate passed 416 files / 4,763 tests with 3 skipped.
- [x] **T7 — Close this spec only.** Run the source-absence audit, focused matrix, typecheck, diff-check, first/full
  candidate gate, one independent review, one consolidated correction round if needed, final full gate, commit,
  push, and close spec/task 376 without changing spec 368 status or unchecked tasks.
  - The final main composition preserves all 18 rebased commits exactly. The canonical matrix passes 910/910;
    typecheck, build, diff-check, source-absence audit, and `npm test` pass; the reviewed branch is published.

## Verification

- [x] No current source/tool/config path can select or execute the legacy delivery lifecycle.
- [x] Canonical creation, sequential join, verification, projection mutation, reload, and compensation tests pass.
- [x] Retirement preview/apply proves byte-stable canonical state and Git state, plus idempotent recovery.
- [x] Removed lifecycle symbols are absent outside the raw retirement module/fixtures; the schema keeps only a
  deprecated, effect-free `settings.delivery` compatibility key so an upgrade warning does not disable the workspace.
- [x] Installed happy-path dogfood uses one Delivery/worktree and emits no legacy artifact.
- [x] `npm run typecheck`, `npm run build`, `git diff --check`, and `npm test` pass on the implementation candidate.

**Headless check:** `npm test`

**Verify:** `npm run typecheck`
**Verify:** `npm test`

## Dogfood

**Dogfood:** `node scripts/dogfood/delivery-lease.mjs --canonical-only`

**Human dogfood:** on the installed candidate, preview the retirement inventory, confirm that it lists metadata
only, apply it after explicit approval, reload, then inspect the one-worktree Delivery lifecycle and the absence of
`reuse_worktree`, `git_delivery_open`, delivery mode settings, and agent-name verification.

## Visual QA

**Visual QA Opt-Out:** only command/notification text changes; installed functional dogfood covers the useful UX.

**Cookbook-Opt-Out:** the one-time retirement is guided by its preview/Doctor confirmation, while canonical
Delivery usage remains described by the existing Bridge tool schemas; this ship adds no second operator workflow.
