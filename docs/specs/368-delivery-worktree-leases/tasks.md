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
- [ ] T6. Generalize the forced-worktree spawn path so a Delivery successor uses the existing worktree, closes the
  prior segment, launches inside the proven process-containment adapter, appends its role-scoped segment, and never
  creates a fallback worktree.
  - Gate: `successor acquire reuses one worktree and never forks an occupied Delivery`.
- [ ] T7. Add fenced handoff and nonce-bound reservation: mark `draining`, freeze/terminate through
  `ProcessFencePort`, require the whole containment group plus worktree-bound process audit to be proven empty,
  revalidate Git, close/reserve, spawn outside locks, then confirm; failures quarantine without phantom occupancy.
  - Gate: `a detached predecessor child prevents successor spawn until the process fence proves empty`.
- [ ] T8. Add `wait_for_lease` as a bounded state watcher that owns no acquisition lock and exits on release,
  quarantine, disappearance, or timeout.
  - Gate: `wait_for_lease is bounded and cannot block an independent release`.
- [ ] T9. Acquire a system verification lease around `verify_task`, checking the canonical current holder rather
  than segment zero; record restore intent, recover clean interruptions, restore delivered HEAD, and verify
  ancestor-linear write segments against their scopes.
  - Gate: `verification excludes a live successor and safely restores an interrupted temporary checkout`.

## Phase 3 — review, recovery, and persistent identities

- [ ] T10. Add exclusive reviewer segments with adapter-level read-only hints and decisive HEAD/index/clean-tree
  postconditions; invalid mutation can never record ACCEPT.
  - Gate: `review ACCEPT is refused when the pinned branch or tracked tree changed`.
- [ ] T11. Reconcile holder death using the same `ProcessFencePort` absence predicate as handoff plus persisted
  process/boot identity, canonical worktree audit, Git status, and recorded HEAD; survivors/unknown quarantine.
  - Gate: `a dirty dead holder quarantines its Delivery while a clean dead holder becomes retryable`.
- [ ] T12. Add explicit salvage/abandon recovery with Bridge-resolved/configured actor policy that never authorizes
  by ephemeral/principal display-name equality, expected-HEAD/loss proof, audit, and human approval for destruction.
  - Gate: `quarantine recovery never treats dirty state as verified or discards data without approval`.
- [ ] T13. Add declared-agent bound executions with unique runtime names and separate `executionAgent`/`principal`
  provenance; prove the live persistent session's cwd, runtime home, token, and continuity are untouched.
  - Gate: `a persistent identity reviews through a bound execution without rebinding or impersonation`.
- [ ] T14. Persist Delivery/segment bindings in the session ledger and reconstruct held/quarantined leases after
  reload, treating ambiguous occupancy as unavailable.
  - Gate: `reload reconstructs an exact lease holder and fails closed on ambiguous occupancy`.

## Phase 4 — projection safety, rollout, and dogfood

- [ ] T15. Serialize linked GitDelivery mutation under the canonical Delivery lock, add idempotent projection
  reconciliation, and make list/hygiene/integration/prune refuse pending, held, verifying, unknown, or quarantined.
  - Gate: `concurrent reconcile and prune cannot diverge GitDelivery from canonical lease safety`.
- [ ] T16. Add config/schema for opt-in rollout and recovery principals; retain legacy behavior by default until
  dogfood evidence is recorded.
  - Gate: `Delivery lease rollout is opt-in and legacy configuration remains compatible`.
- [ ] T17. Add a temp-git integration test covering implement → verify → review FINDINGS → fix → verify → ACCEPT on
  one worktree plus a second concurrent Delivery.
- [ ] T18. Add and run headless dogfood covering the sequential lifecycle, same-Delivery contention refusal, dirty
  crash quarantine, salvage/abandon policy, and GitDelivery hygiene/prune refusal.
  Real sequential lifecycle evidence is blocked until `ProcessFencePort` can return `proven_empty`; current-host
  dogfood is limited to refusal/quarantine behavior.
- [ ] T19. After dogfood and full verification pass, switch new gated orchestration to Delivery leases by default,
  retain explicit legacy compatibility, update docs/tool descriptions, and record the rollout decision.
- [ ] T20. Run SDD closure audit, attach verification/dogfood evidence, mark acceptance criteria, and move
  `t-0b5723` through landed to done only after the shipped status and evidence agree.

## Verification

- [ ] Focused Delivery, Bridge, AgentManager, verify_task, GitDelivery, config, and ledger suites pass.
- [ ] TypeScript checks for extension and webview projects pass.
- [ ] Full canonical verification passes after each integrated phase and at final HEAD.
- [ ] The behavior verifier for every delegated implementation fails at its BASE_SHA and passes at delivered HEAD.
- [ ] No test suppression, authority widening, same-Delivery worktree fork, or destructive recovery bypass is present.

**Headless check:** `npm run verify:full`

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full`

## Dogfood

**Dogfood:** `node scripts/dogfood/delivery-lease.mjs`

**Human dogfood:** inspect `delivery_list`/hygiene output during one real orchestrated implement → review → fix
sequence and confirm that one Delivery/worktree changes occupants without spawning sibling worktrees.

## Visual QA

**Visual QA Opt-Out:** v1 changes headless orchestration, persistence, and structured Bridge output; no visual UI
surface is introduced by this spec.
