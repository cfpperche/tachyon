# SDD 368 T11 adversarial review R2 — ACCEPT

Reviewed the correction delta `f5919dc..70ecb68` (fix commit `70ecb68`, scoped to `src/delivery/leaseService.ts` and `test/unit/deliveryLeaseService.test.ts` only) against my R1 report (`ee9e8dc`, `.tachyon/reviews/368-delivery-lease-t11-r1.md`) and the consolidated correction contract. All three findings (P1, P2, P3) are closed by direct code inspection and by tracing each new regression to confirm it actually forces the previously-broken path rather than merely re-asserting the safe one.

## P1 — non-deterministic concurrent quarantine refusal: CLOSED

`quarantineReconcileAndThrow` (`src/delivery/leaseService.ts:781-806`) now throws `this.reconcileRefusal(parseReason(replay.lease.reason))` immediately when the entry-level `replayReconcileQuarantine` check is truthy (line 783), before ever touching `refusalEvidence`. The `withDeliveryLock`/mutation block is no longer nested inside an `if (!replay)` guard — it is reached only when the entry check found nothing, so the *only* way `refusalEvidence` can end up being the tail-fallthrough `evidence` object is when the caller's own attempt is genuinely the one that either committed the mutation (setting `refusalEvidence = durableEvidence`, line 796) or failed for a reason where nothing else was persisted under this operation id at all — in which case `evidence` is not a misrepresentation of anything durable. Both the outer entry throw (line 783) and the re-check inside the write's own in-lock revalidation (line 791, unchanged) route through `parseReason(...lease.reason)`, so every path that can observe an already-quarantined record now surfaces its actual persisted reason.

Regression: `"replays the immutable quarantine reason when concurrent observers fail differently"` (`test/unit/deliveryLeaseService.test.ts:929-957`) deterministically forces the exact race window rather than merely re-testing the safe sequential case. Its barrier is precise: observer A blocks on `bothObserved`; observer B releases A immediately, then blocks on `committed` (signaled only when a `same-operation:quarantine` write lands) before returning its own distinct failure reason (`"loser"` vs `"winner"`). This guarantees A's quarantine commit happens-before B's `quarantineReconcileAndThrow` entry check — i.e. B is forced through the branch that was previously buggy (truthy replay found at the unlocked entry check) — not the sequential lost-response branch R1 already showed was safe. The assertion `expect(second).toEqual(first)` plus the persisted-reason cross-check (`detail: { evidence: persisted }`) is exactly the determinism property P1 required, and it is the correct discriminator: under the pre-fix code this test would fail (winner's `durableEvidence` carries an extra `currentExecutionNonce` field the loser's stale `evidence` lacks). One `holder_reconcile_quarantined` event is confirmed.

## P2 — unvalidated `detail.segmentId` in interrupted receipt: CLOSED

`replayReconcileInterrupted` (`leaseService.ts:842`) now requires `detail.segmentId !== holder.segmentId || detail.segmentId !== tail.id` (in addition to the pre-existing `tail.id !== holder.segmentId`), so the redundant persisted `detail.segmentId` field is cross-validated against both `holder.segmentId` and `tail.id` — full transitive equality is enforced (one comparison is now logically redundant but harmless).

Regression: the mutation matrix (`test/unit/deliveryLeaseService.test.ts:1139-1158`) adds a distinct `"event-segment"` case (`event.detail!.segmentId = "wrong"`) that mutates *only* the event-detail field, isolated from `holder`/`tail`, and correctly renames the old mislabeled `"segment"` case to `"tail-agent"` (still mutating `segments.at(-1)!.executionAgent`, which is a different, already-covered dimension). This closes exactly the gap identified in R1: a receipt tamper isolated to `detail.segmentId` alone now fails replay (`rejects.toThrow(/does not match/)`), where before it silently passed.

## P3 — held→quarantined mid-flight misclassified as `WORKTREE_OCCUPIED`: CLOSED

Both previously-gapped blocks now insert `if (current.lease.state === "quarantined") throw this.reconcileRefusal(parseReason(current.lease.reason));` immediately after the `["pending","draining","verifying"]` occupied check and before the generic `!== "held"` fallback:
- "alive" live-recheck (`leaseService.ts:293`)
- final interrupted-commit revalidation (`leaseService.ts:328`)

This makes all four state-recheck blocks in `reconcileHolder`/`quarantineReconcileAndThrow` symmetric: owned in-flight states (`pending`/`draining`/`verifying`) remain retryable `WORKTREE_OCCUPIED`; an already-`quarantined` lease is always classified as non-retryable `DELIVERY_QUARANTINED` with the actual persisted reason, regardless of which phase observes it.

Regression: `it.each(["alive","gone"])("replays a concurrent quarantined lease during %s revalidation", ...)` (`test/unit/deliveryLeaseService.test.ts:1055-1074`) independently forces each of the two previously-gapped phases — the `"alive"` case quarantines from inside the process observer (hitting the live-recheck block), the `"gone"` case quarantines from inside `proveEmpty` right before it returns `proven_empty` (hitting the final-commit block) — and both assert `code: "DELIVERY_QUARANTINED", retryable: false, detail: { evidence }` against the exact injected evidence, plus that the persisted lease/reason are untouched by this call. This is the correct pair of forcing points: the two blocks that previously lacked the check.

## Re-audit for new regressions

- No test coverage was removed or weakened; the diff is strictly additive except the "segment"→"tail-agent" rename (same assertion, corrected label).
- The `quarantineReconcileAndThrow` restructuring (de-nesting the write block from `if (!replay) { ... }` to an early-return guard) is a faithful control-flow-preserving transform — confirmed by reading the full method body post-fix (`leaseService.ts:767-825`); brace/scope structure is intact and the outer `catch` block (WORKTREE_OCCUPIED / DELIVERY_QUARANTINED / DELIVERY_WORKTREE_MISMATCH passthrough, inner replay recheck, `persistenceError` aggregation) is unchanged.
- No new receipt field, lock-ordering change, or fence call was introduced; process observation and fence work remain outside every lock in the touched blocks (unchanged from R1's confirmed-correct findings).
- The fix commit `70ecb68` itself touches only `src/delivery/leaseService.ts` and `test/unit/deliveryLeaseService.test.ts`, matching the owned-paths constraint; no architecture/policy expansion, Bridge wiring, or T12 work is present.

## Verification

- `npx vitest run test/unit/deliveryLeaseService.test.ts --maxWorkers=1` — PASS (100 tests, 1 file; 96 prior + 4 new: P1 barrier, P2 event-segment mutation, P3 alive/gone).
- `git diff --check f5919dc..70ecb68 -- src/delivery/leaseService.ts test/unit/deliveryLeaseService.test.ts` — PASS, no whitespace errors.
- `npm run typecheck` / `npm run verify:full` — not run per review contract.
- Review remained read-only for `src/` and `test/`.

## Verdict

ACCEPT
