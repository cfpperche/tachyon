# SDD 368 T11 adversarial review R1 — FINDINGS

Reviewed immutable range `9966e53..f5919dc` (commits `b069563`, `44d988c`, `15785d8`, `fc48894`, `f5919dc`) against the binding "T11 implementation contract — dead-holder reconciliation" in `docs/specs/368-delivery-worktree-leases/notes.md:729-782`, `tasks.md` T11, coordinator pre-review rounds A1/A2, and coordinator hypotheses `j-e0fe1f812cd2` on task `t-0b5723`. Both coordinator hypotheses are confirmed; a third, related inconsistency was found independently. Audited the whole range plus the surrounding `DeliveryStore`/receipt/lock paths (`src/delivery/store.ts`, `src/delivery/types.ts`, `src/agents/processFence.ts`) rather than only the two named files.

## Findings

### P1 — Concurrent identical reconciliation returns a non-deterministic structured refusal (confirms coordinator C1)

Evidence: `quarantineReconcileAndThrow` (`src/delivery/leaseService.ts:765-824`) initializes `refusalEvidence = evidence` (the caller's own local snapshot-based evidence, line 777) and only ever reassigns it to the durable value inside the `if (!replay)` branch (line 794: `refusalEvidence = durableEvidence`). When a concurrent call with the same `operationId`/intent has already committed the quarantine by the time this call's *own* unlocked `replayReconcileQuarantine` check runs (line 780), `replay` is truthy, the `if (!replay)` block — the only place that assigns `durableEvidence` — is skipped entirely, and execution falls straight through to `const refusal = this.reconcileRefusal(refusalEvidence)` (line 819) using the stale, never-persisted `evidence` object.

This is reachable independently of whether the two racers' original failures are identical: `durableEvidence` is defined as `{ ...evidence, currentExecutionNonce: holder?.executionNonce, expectedHeadSha: current.lease.expectedHeadSha }` (line 793) — it always carries an extra `currentExecutionNonce` field that bare `evidence` lacks. So even the fully-deterministic concurrent case in the existing test (`test/unit/deliveryLeaseService.test.ts:905-912`, two identical observers, `{ state: "unknown", reason: "uncertain" }`) produces a structurally different `.detail.evidence` for the transaction winner (which always takes the `durableEvidence` path once it reaches this final fallthrough) versus a genuine same-operationId loser whose own unlocked pre-check resolves *after* the winner's commit lands — a plausible ordering given `getOperationResult`/`update` each open a fresh SQLite connection (`src/delivery/store.ts:142-166`, `241-284`) and this store is explicitly the cross-process authority (class doc comment, `leaseService.ts:238-241`).

This violates the contract's own determinism requirement: "Use immutable operation receipts for terminal `:interrupt` and `:quarantine` mutations... a lost quarantine response replays the same structured refusal... Concurrent identical reconciliation produces one terminal event" (`notes.md:768-772`). One terminal *event* is indeed produced (correct), but the *refusal detail returned to the caller* is not guaranteed identical — only the safe path is exercised by both existing regression tests:
- The sequential "lost response" test (`test/unit/deliveryLeaseService.test.ts:1033-1063`) retries strictly *after* the first call fully completes, so both calls hit a code path (`reconcileHolder`'s top-level entry check at `leaseService.ts:255-256`, or the in-lock re-check at `leaseService.ts:789`) that correctly extracts `parseReason(...lease.reason)` from the persisted record — never the buggy unlocked-check-then-fallthrough path.
- The genuinely concurrent test (`test/unit/deliveryLeaseService.test.ts:905-912`) only asserts `result.reason.code === "DELIVERY_QUARANTINED"` for both racers and a single persisted event — it deliberately does not assert `detail` equality the way the sequential test at line 902 does (`detail: first.detail`), which is exactly the assertion that would have caught this.

Impact: no double-mutation, no incorrect success, no data loss — the safety invariant (single terminal event) holds. But a caller/operator inspecting the thrown error's evidence to understand *why* a Delivery was quarantined can be shown a locally-fabricated reason that was never durably recorded, undermining the audit-grade determinism this whole review series (T7-T11) is built to guarantee.

Correction direction: `quarantineReconcileAndThrow`'s outer `replay` check (line 780) must, when truthy, set `refusalEvidence` from the replayed record's actual persisted reason (`parseReason(replay.lease.reason)`) before falling through, exactly as the entry-level check in `reconcileHolder` (line 256) and the in-lock re-check (line 789) already do. Add a concurrent-duplicate-operationId regression that asserts `detail` equality between both racers' thrown errors (not just the error code), mirroring the existing sequential-replay assertion.

### P2 — `holder_interrupted` receipt replay never validates the persisted `detail.segmentId` field (confirms coordinator C2)

Evidence: the interrupted-commit write persists a redundant `segmentId: open.id` field directly on the event detail (`src/delivery/leaseService.ts:341`), separate from `holder.segmentId` inside `detail.holder`. `replayReconcileInterrupted` (`leaseService.ts:830-848`) cross-checks `tail.id !== holder.segmentId`, `tail.executionAgent`, `tail.principal`, nonce, and every HEAD field, but never reads or compares `detail.segmentId` against anything. The field is written but dead for validation purposes: a receipt mutation that changes only `event.detail.segmentId` (leaving `holder.segmentId`/`tail.id` untouched) passes replay undetected.

This directly contradicts the explicit A2 correction contract: "Extend receipt mutation tests across holder, process/nonce, segment identity, and grant/release HEAD, not only outcome" (`notes.md`, A2 addendum). The test that is supposed to cover this — `it.each([...]) "rejects interrupted receipt mutation: %s"` with the `"segment"` case (`test/unit/deliveryLeaseService.test.ts:1084-1104`) — mutates `malformed.segments.at(-1)!.executionAgent = "wrong"` (line 1099), which is the *tail/executionAgent* check already covered by the `"holder"`/`"nonce"` cases, not a mutation of the actual `detail.segmentId` field. The test is mislabeled and does not exercise the gap it is named for; it currently passes only because tail/holder identity checks happen to catch the executionAgent tamper it does apply, not because segment-identity receipt tampering is caught.

Impact: bounded — `holder.segmentId`/`tail.id` remain the authoritative comparison actually used to accept/reject the tail linkage, so this specific unused field cannot by itself be leveraged to launder an incorrect interrupt. But it is a genuine violation of the stated "every persisted receipt field is tamper-evident" invariant for this series, and the regression meant to prove it is truthful does not.

Correction direction: either validate `detail.segmentId === holder.segmentId` (and equals `tail.id`) in `replayReconcileInterrupted`, or drop the redundant field if intentionally unused — and fix the mislabeled `"segment"` mutation case to actually mutate `detail.segmentId` alone.

### P3 — A held lease that turns `quarantined` mid-flight (by a different concurrent reconciliation) is misreported as retryable `WORKTREE_OCCUPIED`

Evidence: within `reconcileHolder`, four separate `withDeliveryLock` blocks re-fetch `current` and re-check its state, but only two of them special-case `current.lease.state === "quarantined"` before falling through to a generic `"held"` check:
- Initial snapshot phase (`leaseService.ts:264-268`) — **has** the quarantined branch (line 265) before the generic `!== "held"` fallback (line 266-268).
- `quarantineReconcileAndThrow`'s own commit attempt (`leaseService.ts:786-790`) — **has** the quarantined branch (line 789) before the generic fallback (line 790).
- The "alive" live-recheck (`leaseService.ts:292-293`) — **no** quarantined branch; `current.lease.state !== "held"` (line 293) throws generic `this.occupied(...)` → `WORKTREE_OCCUPIED, retryable: true`.
- The final interrupted-commit phase (`leaseService.ts:326-327`) — same gap; line 327 throws the same generic occupied error for *any* non-"held" state, including "quarantined".

Only `reconcileHolder`'s own `quarantineReconcileAndThrow` can transition a `"held"` lease to `"quarantined"` (grepped all four `state: "quarantined"` write sites in `leaseService.ts:559,799,913,987`; the other three all require `"pending"`/`"draining"` predecessors). So this is exactly the case of two independent, differently-`operationId`'d reconciliation attempts (e.g. an automatic health-checker and a manually-triggered reconcile) racing against the same dead holder: whichever loses and reaches the "alive"-recheck or final-commit phase after the winner has already quarantined receives `WORKTREE_OCCUPIED, retryable: true` — a materially wrong classification, since the Delivery is not merely occupied, it is quarantined and (per T12, not yet built) requires an explicit salvage/abandon decision, not a blind retry.

The blast radius is limited: a caller that retries with the *same* `operationId` will self-correct on the very next attempt, because `reconcileHolder`'s entry check or the initial snapshot phase (both of which *do* special-case quarantined) will then catch it. No test in the range exercises this specific mid-flight transition — the existing "competing" coverage (`test/unit/deliveryLeaseService.test.ts:867-874`) only exercises `held → draining`, not `held → quarantined`.

Correction direction: add the same `current.lease.state === "quarantined"` short-circuit (throwing `this.reconcileRefusal(parseReason(current.lease.reason))`) to the "alive" live-recheck and final-commit blocks, matching the pattern already used in the other two blocks in the same function, plus a regression that quarantines the lease via a concurrent operationId mid-flight and asserts the second caller gets `DELIVERY_QUARANTINED`, not `WORKTREE_OCCUPIED`.

## Confirmed correct (no finding)

- Process observation and `ProcessFencePort` work run strictly outside the Delivery/worktree lock in every phase (`leaseService.ts:274-318`), matching `notes.md:748-749`; a dedicated lock-depth test proves it (`test/unit/deliveryLeaseService.test.ts:929-946`).
- `freeze`/`terminate` are never called from `reconcileHolder` — only `capability()` and `proveEmpty()` — matching `notes.md:749-751`; asserted at `test/unit/deliveryLeaseService.test.ts:833-834,945`.
- Double clean-inspection-at-exact-recorded-HEAD gate (`leaseService.ts:330-333`, `assertReconcileInspection` at `729-735`) rejects dirty trees and *any* HEAD drift, including ancestor-linear moves (no ancestor exemption is present, correctly matching `notes.md:754-756`).
- Holder-drift-while-still-held is quarantined rather than treated as retryable occupancy (`leaseService.ts:328-329`), matching `notes.md:762-764`; covered by `test/unit/deliveryLeaseService.test.ts:857-865`.
- A store-legal concurrent tail closure surfacing only on the second live observation is caught and replays exactly (`test/unit/deliveryLeaseService.test.ts:974-990`), closing the A2 "live-tail drift" gap.
- Lock ordering is consistently Delivery-then-canonical-worktree in every new block, matching the class-level invariant comment (`leaseService.ts:238-241`).
- `DeliveryStore.update`'s CAS is genuinely enforced under `BEGIN IMMEDIATE` re-validated against fresh row state (`store.ts:266-283`), so the underlying single-terminal-event safety property that P1 depends on for "no double mutation" does hold.

## Verification

- `npx vitest run test/unit/deliveryLeaseService.test.ts --maxWorkers=1` — PASS (96 tests, 1 file).
- `git diff --check 9966e53..f5919dc` — PASS, no whitespace errors.
- `npm run typecheck` / `npm run verify:full` — not run per review contract (already green from the executor's own prior gate run).
- Review remained read-only for `src/` and `test/`.

## Verdict

FINDINGS
