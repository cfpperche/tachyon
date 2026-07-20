# 368 — delivery-worktree-leases — tasks

_Generated from `plan.md` on 2026-07-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Design gate

- [x] T0. Run an adversarial architecture review against `spec.md` and `plan.md`; fold every accepted finding and
  record explicit dispositions for rejected findings in `notes.md`.
- [x] T0.1. Re-run the review after the fold and require an ACCEPT verdict before delegating production changes.
- [x] T0.2. Empirically spike a `ProcessFencePort` on the supported host: launch a Delivery execution that creates a
  detached/reparented writer, terminate the pane root, and prove the adapter reports survivors until every member
  is gone; document capability-unavailable behavior for hosts without sound containment.

## Phase 1 — canonical aggregate and compatibility

- [x] T1. Add versioned Delivery/contract/lease/segment/event types and a SQLite-backed `DeliveryStore` with
  `BEGIN IMMEDIATE` short transactions, CAS versions, immutable-contract enforcement, append-only unique segment/
  event history, operation receipts for idempotent retry, and capability-gated local lock-domain validation.
  - Gate: `DeliveryStore recovers a crash-interrupted transaction without duplicating immutable append-only state`.
- [x] T2. Create one Delivery plus implementer segment zero for new gated spawns, link a GitDelivery projection by
  `deliveryId`, and preserve the legacy gated-spawn path behind compatibility settings.
  - Gate: `a gated spawn creates exactly one canonical Delivery and one Git projection`.
- [x] T3. Implement deterministic legacy preview/apply import from DelegationRecord + fixerAttempts + optional exact
  GitDelivery match; ambiguous drift or non-linear segment history refuses without writing.
  - Gate: `legacy import preserves linear provenance and refuses ambiguous Git projections without mutation`.
- [x] T4. Teach `verify_task` to resolve by `delivery_id` first and exactly-one-non-archived legacy agent-name sugar
  second, using an adapter rather than a duplicate DelegationRecord; forbid mtime selection.
  - Gate: `verify_task refuses ambiguous same-name legacy delegations instead of selecting by mtime`.

## Phase 2 — lease and sequential occupants

- [x] T5. Add `DeliveryLeaseService` with fail-closed acquire, normalized authority subset checks, expected-HEAD pin,
  ancestor-linear boundary checks, durable holder/liveness state, and a single global lock order.
  Current-host constraint: expose capability unavailable; do not enable successor handoff without a complete
  adapter that can prove both containment-group and independent worktree-binding absence.
  - Gate: `concurrent acquire grants one Delivery lease and returns retryable WORKTREE_OCCUPIED to the loser`.
- [x] T6. Generalize the forced-worktree spawn path so a Delivery successor uses the existing worktree, closes the
  prior segment, launches inside the proven process-containment adapter, appends its role-scoped segment, and never
  creates a fallback worktree.
  - Gate: `successor acquire reuses one worktree and never forks an occupied Delivery`.
- [x] T7. Add fenced handoff and nonce-bound reservation: mark `draining`, freeze/terminate through
  `ProcessFencePort`, require the whole containment group plus worktree-bound process audit to be proven empty,
  revalidate Git, close/reserve, spawn outside locks, then confirm; failures quarantine without phantom occupancy.
  - Gate: `a detached predecessor child prevents successor spawn until the process fence proves empty`.
- [x] T8. Add `wait_for_lease` as a bounded state watcher that owns no acquisition lock and exits on release,
  quarantine, disappearance, or timeout.
  - Gate: `wait_for_lease is bounded and cannot block an independent release`.
- [x] T9. Acquire a system verification lease around `verify_task`, checking the canonical current holder rather
  than segment zero; record restore intent, recover clean interruptions, restore delivered HEAD, and verify
  ancestor-linear write segments against their scopes.
  - Gate: `verification excludes a live successor and safely restores an interrupted temporary checkout`.

## Phase 3 — review, recovery, and persistent identities

- [x] T10. Add exclusive reviewer segments with adapter-level read-only hints and decisive HEAD/index/clean-tree
  postconditions; invalid mutation can never record ACCEPT.
  - Gate: `review ACCEPT is refused when the pinned branch or tracked tree changed`.
- [x] T11. Reconcile holder death using the same `ProcessFencePort` absence predicate as handoff plus persisted
  process/boot identity, canonical worktree audit, Git status, and recorded HEAD; survivors/unknown quarantine.
  - Gate: `a dirty dead holder quarantines its Delivery while a clean dead holder becomes retryable`.
- [x] T12. Add explicit salvage/abandon recovery with Bridge-resolved/configured actor policy that never authorizes
  by ephemeral/principal display-name equality, expected-HEAD/loss proof, audit, and human approval for destruction.
  - Gate: `quarantine recovery never treats dirty state as verified or discards data without approval`.
- [x] T13. Add declared-agent bound executions with unique runtime names and separate `executionAgent`/`principal`
  provenance; prove the live persistent session's cwd, runtime home, token, and continuity are untouched.
  - Gate: `a persistent identity reviews through a bound execution without rebinding or impersonation`.
- [x] T14. Persist Delivery/segment bindings in the session ledger and reconstruct held/quarantined leases after
  reload, treating ambiguous occupancy as unavailable.
  - Gate: `reload reconstructs an exact lease holder and fails closed on ambiguous occupancy`.

## Phase 4 — projection safety, rollout, and dogfood

- [x] T14.5. Prove supported-host ProcessFence feasibility and ratify its threat model: transient user cgroup
  containment plus a checksum-pinned `CAP_SYS_PTRACE` helper must return exact empty/survivor outcomes with zero
  unknown evidence; deliberate malicious control of the same Linux account is explicitly out of scope.
  - Gate: `a capped FDSize-bounded audit reports empty with no binding and the exact open FD as a survivor`.
- [x] T14.6. Complete the shipped mechanism-only handoff-safety stage, preserve the reviewed Linux
  `ProcessFencePort` core, and extract the stronger production rollout so mechanism-only can never impersonate its
  proof.
  - [x] T14.6A. Land and independently review the injected Linux systemd/cgroup adapter, nonce-bound identity
    registry, exact-snapshot action gates, checksum-pinned helper parser, and deterministic adversarial matrix.
  - [x] T14.6B. Wire an explicitly experimental `mechanism-only` policy into exact Delivery-bound
    acquire/handoff/review-completion plus Workspace/AgentManager prepare/confirm/fail callbacks and a
    coordinator-authorized review-completion Bridge operation. Initial canonical gated spawn must persist an exact
    root identity and execution nonce. Stop only the exact ledger-bound execution, require that identity gone,
    record `root_gone_best_effort`, warn that descendants are unproven, and keep reconciliation/recovery plus any
    pre-T15 integration/prune route fail-closed. Generic/legacy launch remains byte-compatible.
    - [x] T14.6B1. Land the lease-service safety policy, structured absence evidence, replay-before-ambient-gate
      semantics, exact-root stop/observe path, quarantine behavior, and deterministic forcing matrix.
    - [x] T14.6B2. Wire Workspace/AgentManager/config/Bridge, initial process identity and nonce persistence,
      review completion authority, and operator-visible mechanism-only warnings.
  - [x] T14.6C disposition. Do not claim or wire strong mode in this shipped boundary. Transfer capability/helper,
    launch/reload identity, compensation/recovery, and installed adversarial rollout to umbrella `t-f25434` and
    follow-ups `t-a26f3c`, `t-816d7f`, `t-f55bf7`, and `t-9cf3ae`.
  - Deferred gate: `a detached Delivery writer survives pane death but cannot cross handoff after scope kill and
    exact audit` — owned by `t-9cf3ae`, not satisfied by this spec.
- [x] T15. Serialize linked GitDelivery mutation under the canonical Delivery lock, add idempotent projection
  reconciliation, and make list/hygiene/integration/prune refuse pending, held, verifying, unknown, or quarantined.
  T15 policy acceptance is a prerequisite for mechanism-only dogfood so no legacy projection mutation bypasses the
  experimental lease.
  - Gate: `concurrent reconcile and prune cannot diverge GitDelivery from canonical lease safety`.
- [x] T16 supersession. Spec 376 replaced the selectable rollout with canonical mechanism-only as the sole product
  path, retained only an effect-free deprecated `settings.delivery` compatibility key, and preserved governed
  recovery principals plus the descendant-isolation warning. Strong `process-fenced` configuration is deferred to
  `t-816d7f`; the originally planned disabled/legacy default did not ship and is not claimed.
- [x] T17. Add a temp-git integration test covering implement → verify → review FINDINGS → fix → verify → ACCEPT on
  one worktree while a second independent Delivery remains live in its own worktree. The forcing test is
  `test/unit/workspaceHeadless.test.ts` under the dogfood title used by `scripts/dogfood/delivery-lease.mjs`.
- [x] T18. Run mechanism-only headless and installed dogfood for the sequential lifecycle, and retain the focused
  forcing matrices for same-Delivery contention, dirty/head drift quarantine, salvage/abandon policy, and
  GitDelivery hygiene/prune refusal. `dogfood-0.55.95.md` explicitly records `descendants_unproven`; later governed
  recovery dogfood is recorded by specs 376/379 and their task journals. Strong crash isolation remains in
  `t-f25434`.
- [x] T19 supersession. Spec 376 removed the legacy selector and made new gated orchestration canonical
  mechanism-only after installed dogfood; current schemas/tool descriptions expose no selectable legacy lifecycle.
- [x] T20. Reconcile the SDD as shipped, attach current verification/dogfood evidence, extract T14.6C into
  explicit follow-ups, and close the original design task `t-0b5723` through `landed` to `done` under closure task
  `t-2c3c94`.

## Verification

- [x] Focused Delivery, Bridge, AgentManager, verify_task, GitDelivery, config, and ledger suites pass.
- [x] TypeScript checks for extension and webview projects pass.
- [x] Full canonical verification passes after each integrated phase and at final HEAD.
- [x] The behavior verifier for every delegated implementation fails at its BASE_SHA and passes at delivered HEAD.
- [x] No test suppression, authority widening, same-Delivery worktree fork, or destructive recovery bypass is present.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `node scripts/dogfood/delivery-lease.mjs`

**Human dogfood:** inspect `delivery_list`/hygiene output during one real orchestrated implement → review → fix
sequence and confirm that one Delivery/worktree changes occupants without spawning sibling worktrees.

## Visual QA

**Visual QA Opt-Out:** v1 changes headless orchestration, persistence, and structured Bridge output; no visual UI
surface is introduced by this spec.

**Cookbook-Opt-Out:** canonical Delivery operations are documented by their current Bridge tool schemas and later
recovery specs; this historical architecture spec introduces no additional operator workflow at closure.
