# SDD 368 T12 adversarial review R1 — FINDINGS

Reviewed immutable range `4e0cb912..7a9d82fa` (single commit `7a9d82fa`, scoped exactly to `src/delivery/types.ts`, `src/delivery/leaseService.ts`, `test/unit/deliveryLeaseService.test.ts`) against the binding "T12 implementation contract — explicit quarantine salvage/abandon" (`docs/specs/368-delivery-worktree-leases/notes.md:847-929`). Audited the whole delta plus the surrounding `DeliveryStore` (`src/delivery/store.ts`), `verificationLease.ts`, `processFence.ts`, and every other public method in `leaseService.ts` for consistency. All five coordinator hypotheses are addressed below; two additional high-severity issues were found independently.

## Findings

### H1 — The terminal `abandoned` state is misclassified as retryable `WORKTREE_OCCUPIED` at three call sites (confirms hypothesis 3)

Evidence: the contract requires `abandoned` to be "neither released nor acquirable" — a permanent terminal state. But every non-`waitForDeliveryLease` gate that rejects a non-matching lease state routes an `abandoned` Delivery through the generic "occupied" path, which always returns `WORKTREE_OCCUPIED` with `retryable: true`:

- `assertAcquirable` (`leaseService.ts:1032-1034`): `if (delivery.lease.state !== "free") throw this.occupied(...)`. An `abandoned` Delivery falls through here exactly like a transiently `held`/`pending` one.
- `recoverySnapshot` (`leaseService.ts:857-864`, new in this range): `if (current.lease.state !== "quarantined") throw this.occupied(current, "Delivery is not quarantined");` — used by both `salvageQuarantine` and `abandonQuarantine`, so attempting to recover an *already-abandoned* Delivery gets the same "retryable occupied" treatment as attempting to recover one that's merely busy.
- `verificationLease.ts:84-85` (pre-existing, outside T12's owned paths but explicitly in-scope for this audit): `if (current.lease.state !== "free" && current.lease.state !== "held") throw this.occupied(...)` — the canonical system-verification lease acquisition path also has no awareness of the new state and will forever report `abandoned` as retryable occupancy.

By contrast, `handoff`'s `assertHandoffAuthority` (`leaseService.ts:950-953`) and `reconcileHolder`'s snapshot check (`leaseService.ts:266-268`) both fall through to `DELIVERY_INVALID_STATE` (`retryable: false`) for any state that isn't explicitly listed — so `abandoned` is already handled *correctly* there. The gap is specific to the three sites above.

Impact: a caller (automated retry loop, health-checker, or a future T16 Bridge wiring built to retry on `retryable: true`) that hits any of these three paths against an abandoned Delivery will retry forever against a state that can never succeed, rather than surfacing the permanent, actionable "this Delivery is abandoned" signal the whole point of the terminal state is meant to provide. This is a simple, deterministic, fully reproducible defect (create a Delivery, abandon it, call `acquire`/`salvageQuarantine`/`abandonQuarantine` against it) requiring no race or timing — and it is untested (see H3).

Correction direction: special-case `abandoned` before the generic fallback at all three sites (own paths: `assertAcquirable`, `recoverySnapshot`; flag `verificationLease.ts:84-85` for a tracked follow-up since it is outside T12's owned scope) and throw a non-retryable structured refusal instead.

### H2 — `salvageQuarantine`/`abandonQuarantine` never catch their own store-layer race errors; the exact "one winner, loser observes result" contract requirement throws a raw, untranslated exception

Evidence: every other public mutation method in this class wraps its `store.update` call and translates the two expected race outcomes into a structured `DeliveryLeaseError`:
- `acquire`/`acquireInternal` (`leaseService.ts:472-481`): catches `DeliveryVersionConflictError` → replays or re-reads the winner and throws `this.occupied(winner, "another acquisition won the Delivery CAS")`; catches `DeliveryStoreBusyError` → `this.busy(error)`.
- `confirmHeld`/`confirmHeldInternal` (`leaseService.ts:532-540`) does the same for its own CAS.
- The top-level `acquire()`/`confirmHeld()` wrappers additionally catch a bare `DeliveryStoreBusyError` from anywhere in the internal call (`leaseService.ts:360-366`, `486-492`).

`salvageQuarantine` (`leaseService.ts:394-421`) and `abandonQuarantine` (`leaseService.ts:423-445`) have **no try/catch at all** around their bodies, including the final `this.deps.store.update(...)` call. This is precisely the site where a genuine concurrent race lands: the contract's own "Receipts and failure behavior" section requires "Concurrent salvage/abandon attempts permit one winner; the loser observes the resulting owned/terminal state and cannot append a second segment or event" — i.e. a real cross-process race (two separate `DeliveryLeaseService` instances, since `withDeliveryLock`/`withWorktreeLock` are purely in-process mutexes and provide zero protection across processes; only the SQLite CAS in `store.update` is the cross-process authority per the class's own doc comment at `leaseService.ts:238-241`) is exactly the scenario `DeliveryVersionConflictError` exists to signal. With no catch, that error propagates as a bare `Error` (not a `DeliveryLeaseError`), breaking `instanceof DeliveryLeaseError`/`.code`/`.retryable` for any caller (including a future T16 Bridge tool) that relies on this class's established error shape to decide whether to retry or surface a permanent failure. The same gap applies to `DeliveryStoreBusyError` from any of the several `store.get`/`store.update` calls inside these two methods.

This is a stronger, code-level version of coordinator hypothesis 4's "store busy/version conflicts can leak raw errors" and directly bears on hypothesis 3's "two-store races" — the contract's requirement that the loser "observes the resulting owned/terminal state" is not met at all; the loser gets an opaque internal error type instead.

Minor related observation: even the *in-process* race path (`assertRecoverySnapshot`, `leaseService.ts:882-886`) throws the generic `DELIVERY_QUARANTINED "quarantine changed during recovery"` regardless of what the delivery transitioned *to* (e.g. a competing salvage's `pending` or a competing abandon's `abandoned`) — `retryable: false` is set correctly so this doesn't create a retry-loop hazard on its own, but the message/code doesn't tell the loser which terminal/owned state actually won, unlike `acquire()`'s pattern of re-reading and reporting the winner.

Correction direction: wrap both methods (or their internal implementations) exactly as `acquire`/`confirmHeld` do — catch `DeliveryVersionConflictError` by re-reading the current Delivery and reporting its actual resulting state, and catch `DeliveryStoreBusyError` via `this.busy(error)`.

### H3 — The committed test matrix covers a small fraction of the contract's own explicit "Deterministic test matrix" (confirms and substantially exceeds hypothesis 5)

Evidence: the range adds exactly three tests (`test/unit/deliveryLeaseService.test.ts:1179-1216`): one happy-path salvage, one happy-path abandon-with-replay, and one authority-denial case (quarantined holder's own name). The contract's test-matrix paragraph (`notes.md:920-929`) explicitly enumerates a much larger required set. Cross-checking each clause against the diff:

| Required by contract | Present? |
|---|---|
| Original-creator salvage | Yes (`:1179`) |
| Configured-principal (non-creator) salvage | **No** |
| Deny principal-name / execution-name equality (distinct from holder) | **No** |
| Deny `legacy`/`external` actor kinds | **No** |
| Deny unconfigured peer (baseline denial) | **No** |
| Prove fence work occurs outside locks | **No** — every other T7-T11 slice has an explicit `lockDepth`-style test for this; T12 has none |
| Only `proven_empty` advances (refuse unavailable/unknown/survivors/capability-missing) | **No** |
| Refuse holder-less quarantine | **No** |
| Refuse canonical-path drift | **No** |
| Refuse lease/tail drift | **No** (the exact gap H1/M1 concern is consequently unverified) |
| Refuse HEAD mismatch | **No** |
| Refuse dirty-path / unique-commit drift | **No** |
| Refuse unstable inspection (first ≠ second) | **No** |
| Refuse malformed inventory | **No** |
| Refuse scope (`ownsSubset`) widening | **No** |
| Salvage produces dirty evidence, never "verified/accepted/clean/completed" | Implicit only (asserted fields don't claim it, but nothing explicitly proves the negative) |
| Abandon requires exact approved receipt; reject pending/denied/foreign/tampered/unbound/replayed-for-different-loss | Happy path only — **no rejection case for any of these** |
| Mutate every approval binding field independently | **No** — zero mutation tests for `decision`/`requester`/`actionDigest`/`payloadHash`/`resolvedAt` |
| Same-operation replay skips all effects (fence, inspection, approval) | Partial — only approval call-count is checked (`:1194`, abandon only); fence/inspection call-counts are never asserted, and there is no equivalent replay-skip test for salvage at all |
| Salvage-vs-abandon and same-action two-store races, exactly one winner | **No** — zero concurrency tests for T12, in sharp contrast to T7-T11's extensive `Promise.all`/`Promise.allSettled` race coverage |

This is not a marginal gap: of roughly 20 explicitly named required cases, 3 are covered and most of the rest — including every refusal-without-mutation case, the entire fence-and-lock-boundary proof, the full approval-tamper matrix, and all concurrency — are completely absent. Several of these (fence failure, inventory/HEAD/tail drift, approval tampering, and the H2 race above) are exactly the invariants this whole T5-T12 arc exists to prove are byte-for-byte safe under adversarial conditions; shipping this candidate leaves them verified only by code inspection, not by regression.

## Hypothesis verdicts

1. **`assertRecoverySnapshot` compares only `lease`, evading the frozen tail — CONFIRMED (MEDIUM).** `assertRecoverySnapshot(delivery: Delivery, snapshot: { lease: Delivery["lease"] })` (`leaseService.ts:881-886`) and its two call sites (`recoveryCurrent` at `:875-879`, and inside both `store.update` mutate callbacks at `:406` and `:437`) only ever compare `delivery.lease` to `snapshot.lease`. `holder` is covered incidentally (it is nested inside `lease`), but the tail segment (`delivery.segments.at(-1)`) is not compared at all, even though `recoverySnapshot` already captures `tail` separately (`leaseService.ts:863`) and the contract explicitly requires the snapshot to include "the exact quarantined lease, holder, open tail, reason" and to "revalidate the complete snapshot ... immediately before the durable CAS." No method currently in this file can mutate `segments` while leaving `lease.state === "quarantined"` unchanged, so there is no reachable production exploit today — but this is a direct, literal gap against the contract's own language, and it is inconsistent with this file's established pattern elsewhere (`heldBoundaryFailure`, `assertExactHolder` plus tail-linkage checks) of treating the open tail as part of the exact boundary that must be re-verified, not merely implied by the lease.

2. **`replayRecovery` under-validates persisted fields relative to holder/reservation/tail/inventory/approval — PARTIALLY REFUTED.** `replayRecovery` (`leaseService.ts:889-895`) is structurally identical to the already-accepted `replayReviewCompletion`/`replayEvent` pattern (type + full-intent-deep-equality + terminal-state check), not the much more elaborate T11 `replayReconcileInterrupted`/`replayReconcileQuarantine` pattern. Because `DeliveryStore.getOperationResult` returns an immutable `structuredClone` of the exact record committed for that `operationId` (`store.ts:150-166`), the returned delivery is by construction internally consistent with what was persisted — there is no live-re-read gap here the way T11 had. The `intent` comparison does cover holder/scope/inventory/approvalId, since `intent` is built by spreading the full normalized `input` (`leaseService.ts:395`, `423-424`), so "any changed action, inventory, actor, scope, execution identity, approval, or canonical path" reusing an operation id is correctly refused via the intent-equality check. This part of the hypothesis does not hold up against the actual `getOperationResult` semantics. The real, adjacent gap is H2 above (the CAS failure path itself, not replay).

3. **New `abandoned` terminal state has no store invariants and is still classified retryable by acquire/verification/recovery paths — CONFIRMED, see H1.**

4. **Authority happens only after acquiring the caller-supplied worktree lock/canonical resolution; fence/inspection/approval throws and store busy/version conflicts can leak raw errors — CONFIRMED (split into two).** `salvageQuarantine`/`abandonQuarantine` call `recoverySnapshot`, which acquires `withDeliveryLock` + `withWorktreeLock` (using the caller-supplied, only `path.resolve`d worktree string) and reads the store *before* `assertRecoveryActor` runs inside that same locked callback (`leaseService.ts:857-861`). No fence, Git observation, nonce allocation, or mutation happens before the authority check — so the letter of "the service performs this policy itself before any fence, Git observation, nonce allocation, or mutation" holds, and this ordering is consistent with every pre-existing method in the file (all of which lock-then-validate). But it does mean an unauthorized caller can still contend for the Delivery's exclusive in-process lock before being rejected, which the contract's underlying intent (policy gates recovery of a sensitive quarantined state) arguably wants to avoid for this specific, newly-authority-gated operation. Rated MEDIUM (M3) since it does not bypass the authorization decision itself. The raw-error-leak half of this hypothesis is real and is the dominant part of **H2** above.

5. **`localeCompare` digest canonicalization and the three-test matrix may not prove the required cases — CONFIRMED, both halves.** See H3 for the test-matrix half. On canonicalization: `normalizeRecoveryInventory` (`leaseService.ts:1260-1275`) sorts `dirtyPaths` with `a.path.localeCompare(b.path) || a.status.localeCompare(b.status)` (`:1266`). `String.prototype.localeCompare` without an explicit locale/options argument uses the host's default ICU locale, which is not guaranteed identical across processes, hosts, or Node builds. Because this sorted array becomes part of both `isDeepStrictEqual` structural comparisons (`:406-408`, `:435-437` — the two-inspection-equal-to-expectation check) and the input to `recoveryActionDigest`'s SHA-256 hash (`:1277-1279`, consumed for abandon's approval binding), a semantically identical inventory observed under two different locale/ICU configurations could sort differently, producing (a) a spurious inventory-drift refusal even though nothing actually changed, or (b) a different action digest for the same logical abandon intent, causing a validly-approved receipt (approved against one canonical ordering) to fail the exact-digest check (`recoveryApproval`, `:872-877`) against a different ordering computed elsewhere. This is a real defect class (the classic locale-dependent-comparison pitfall) for a value explicitly described in the contract as "canonical, duplicate-free, deterministically ordered" and used as cryptographic-adjacent binding material; it requires an actual locale/ICU difference between the environments producing and consuming the digest to manifest, which is plausible in this codebase's stated cross-process/cross-host design but not certain in a single-locale deployment.

## Confirmed correct (no finding)

- Fence work (`capability()` + `proveEmpty()`, never `freeze`/`terminate`) runs strictly outside both locks in the actual control flow of both `salvageQuarantine` and `abandonQuarantine` — `proveRecoveryEmpty` (`leaseService.ts:866-870`) is called after `recoverySnapshot`'s lock has already released and before the final `withDeliveryLock` block. Matches contract; only untested (H3).
- The double-inspection-under-lock-immediately-before-CAS structure (`leaseService.ts:398-402`, `429-433`) correctly throws without calling `store.update` on any drift, satisfying "no partial segment/event append" for that failure class.
- `ownsSubset` widening is checked against the immutable contract inside the lock for salvage (`leaseService.ts:397`).
- Salvage's persisted event/segment never claims verification (`outcome: "interrupted"` on the closed predecessor, `role: "recovery"` + `state: "pending"` on the new one — no "verified"/"accepted"/"clean"/"completed" language anywhere in the write).
- Abandon's approval binding (`recoveryApproval`, `leaseService.ts:872-877`) does check decision/requester/digest/payloadHash/resolvedAt presence before proceeding, and the digest is derived from delivery id + expected HEAD + inventory + intent, matching "canonical action digest over Delivery id, expected HEAD, exact loss inventory, and operation intent" (modulo the canonicalization concern in hypothesis 5).
- `waitForDeliveryLease` correctly recognizes `abandoned` as a distinct terminal outcome (`leaseService.ts:110`), and existing free/pending/held/draining/verifying/quarantined behavior is unchanged by this diff.
- `handoff` and `reconcileHolder`'s state-gating already correctly classify `abandoned` as non-retryable `DELIVERY_INVALID_STATE` — no regression there.
- The commit is scoped to exactly the three named owned paths; no Bridge/Workspace/config/GitDelivery wiring or destructive Git/filesystem action is present.

## Verification

- `npx vitest run test/unit/deliveryLeaseService.test.ts --maxWorkers=1` — PASS (103 tests, 1 file).
- `git diff --check 4e0cb912..7a9d82fa` — PASS, no whitespace errors.
- `npm run typecheck` / `npm run verify:full` — not run per review contract.
- Review remained read-only for `src/` and `test/`.

## Verdict

FINDINGS
