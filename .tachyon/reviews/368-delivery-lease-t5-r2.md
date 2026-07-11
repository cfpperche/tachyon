# SDD 368 T5 R2 — delta adversarial review of `43c02bd` against R1 (`18fc55f`)

**Verdict: ACCEPT**

Scope: delta `e4c66cf..43c02bd` — `src/delivery/leaseService.ts`, `src/delivery/store.ts`,
`test/unit/deliveryLeaseService.test.ts`. R1 (`18fc55f`, reviewing `e4c66cf`) raised F1–F8; this review
determines whether the fix commit closes each one, reproducing the previously-broken paths against the
fixed code and probing the new replay machinery for the failure modes R1's methodology would predict
(operationId collision/intent confusion, replay after later Delivery mutations, stale `result_json`
semantics, error ordering around the new pre-CAS HEAD recheck, and confirmHeld's CAS under real
cross-process contention). The current host remains capability-unavailable
(`DELIVERY_LEASE_UNAVAILABLE`), so none of this is reachable via a real acquisition yet; everything below
was verified by driving the real `leaseService.ts`/`store.ts` sources directly (bundled with esbuild into a
single combined module to avoid a dual-module-instance artifact — see note under F3) against a real
`node:sqlite` database, plus the shipped unit suite.

## F1 — HIGH — lost `acquire()` response cannot be safely retried — **CLOSED**

`acquireInternal` (`leaseService.ts:89-194`) now computes the domain `intent`
(`acquireIntent`, `leaseService.ts:317-329`) and calls `this.replayAcquire(...)` (`leaseService.ts:96-97`)
*before* `withDeliveryLock`, again immediately after acquiring the lock (`leaseService.ts:99-100`), and
again from the `DeliveryVersionConflictError` catch branch (`leaseService.ts:184-185`) — all ahead of the
state-based `assertAcquirable` check that previously intercepted retries first. `replayAcquire`
(`leaseService.ts:272-282`) reads the durable receipt via the new `DeliveryStore.getOperationResult`
(`store.ts:150-166`) and validates the caller's freshly-recomputed `intent` against the `lease_reserved`
event's `detail.intent` with `isDeepStrictEqual` before trusting the replay.

Reproduced empirically (own probe, since R1's `probe.cjs` no longer applies to the new code shape): a
successful `acquire()` with `operationId: "acquire-op-1"` followed by an identical retry now returns the
**same `reservationNonce`** instead of throwing `WORKTREE_OCCUPIED`. The shipped test
`"normalizes authority, pins HEAD and records durable process identity on confirmation"`
(`deliveryLeaseService.test.ts:74-89`) also retries `acquire()` with the same `operationId: "reserve"` (and
even reorders/duplicates the `ownsSubset` entries to prove normalization is intent-stable) and asserts
`retriedReservation` equals the original — this is exactly R1's required regression test.

## F2 — HIGH — `confirmHeld()` has the identical unsafe-retry defect — **CLOSED**

Same shape as F1: `confirmHeldInternal` (`leaseService.ts:204-252`) calls `this.replayConfirmation(...)`
before the delivery lock, after it, and from the version-conflict catch branch, all ahead of the
`pending`/nonce state check. `replayConfirmation` (`leaseService.ts:284-292`) requires a matching
`lease_held` event with `detail.operationId` equal to the call's `operationId` and `isDeepStrictEqual`
intent match, plus `delivery.lease.state === "held"`.

Reproduced empirically: `confirmHeld()` followed by an identical retry (same `operationId`) now returns the
same committed `Delivery` instead of throwing `WORKTREE_OCCUPIED: reservation is no longer pending for this
nonce`. Also covered by `deliveryLeaseService.test.ts:90-95`, which retries `confirmHeld` with
`operationId: "confirm"` and asserts equality with the first result.

## F3 — HIGH — genuine SQLite busy contention escapes the `WORKTREE_OCCUPIED` contract — **CLOSED**

Every call path in both `acquire()` and `confirmHeld()` now funnels through an outer try/catch
(`leaseService.ts:82-87`, `197-202`) that translates any `DeliveryStoreBusyError` into a structured,
retryable `WORKTREE_OCCUPIED` via `this.busy()` (`leaseService.ts:266-270`), in addition to the
inner catches at the `store.update` call sites (`leaseService.ts:189`, `248`). Because the outer wrapper
covers the *entire* `acquireInternal`/`confirmHeldInternal` body, this closes F3 regardless of exactly which
underlying `store` call (`get`, `getOperationResult`, or `update`) actually hits `SQLITE_BUSY` — verified
this holds even for the busy error surfacing from the pre-lock replay short-circuit
(`store.getOperationResult`), not just from `store.update`.

Reproduced empirically, both via the shipped test
`"translates a real SQLite BEGIN IMMEDIATE collision into retryable WORKTREE_OCCUPIED"`
(`deliveryLeaseService.test.ts:102-118`, holds a real second `DatabaseSync` connection's `BEGIN IMMEDIATE`)
and via an independent probe that additionally holds the write lock during a `confirmHeld` call before the
delivery lock is even taken — both surface `DeliveryLeaseError{code: "WORKTREE_OCCUPIED", retryable: true}`.

*Methodology note:* my first attempt at this probe bundled `leaseService.ts` and `store.ts` as two
**separate** esbuild bundles (mirroring R1's `bundle.mjs`/`bundle2.mjs`), which produces two structurally
identical but distinct `DeliveryStoreBusyError` classes, so `error instanceof DeliveryStoreBusyError` inside
the bundled `leaseService.cjs` spuriously fails against a `DeliveryStore` instance built from the other
bundle — a bundling artifact, not a product bug. Re-bundling both modules from one shared entrypoint (so
`store.ts` is inlined exactly once) reproduces the fix correctly: `WORKTREE_OCCUPIED`, `retryable: true`.
Flagging this in case it resurfaces in a future review using the same two-bundle technique.

## F4 — MEDIUM — `confirmHeld` didn't translate a genuine CAS race — **CLOSED (code)**, test gap remains

`confirmHeldInternal`'s `store.update` call is now wrapped in the same try/catch shape as `acquire()`
(`leaseService.ts:217-250`): a `DeliveryVersionConflictError` first tries `replayConfirmation` (for the case
where the winner *was* this same operation replaying), then falls back to `this.occupied(winner, ...)`, and
`DeliveryStoreBusyError` is translated via `this.busy()`.

Reproduced empirically with two independent `DeliveryStore`/`DeliveryLeaseService` instances over one
SQLite file (simulating two processes, no shared in-process mutex) racing `confirmHeld` for the same
reservation: exactly one settles, the loser is rejected with `error instanceof DeliveryLeaseError` and
`{code: "WORKTREE_OCCUPIED", retryable: true}` — no raw `DeliveryVersionConflictError` escapes.

Gap: R1's required closure also asked for "a concurrent-`confirmHeld` test analogous to the existing
concurrent-`acquire` test." The shipped suite (6 tests) has no such test — only the single-caller retry test
(F2) and the single-caller busy test (F3) touch `confirmHeld`. The behavior is correct (verified above by
direct reproduction against the real sources), so this is a LOW test-coverage gap, not a functional defect;
recommend a follow-up test analogous to `deliveryLeaseService.test.ts:52-72` but for `confirmHeld`.

## F5 — MEDIUM — live-HEAD TOCTOU only closed in-process — **ACCEPTABLY DISPOSITIONED**

The fix narrows the in-process window further: `acquireInternal` now re-reads HEAD immediately before the
CAS commit (`leaseService.ts:142-147`, `recheckedHead`) and refuses with `DELIVERY_HEAD_CHANGED` if it moved
since the first read — closing the specific gap where the intervening `isAncestor` call (a real Git
operation, potentially slow) could let HEAD drift between the original `readHead` and the commit. Covered by
`deliveryLeaseService.test.ts:120-134`, which forces `readHead` to return a different value on its second
call and asserts the acquisition is refused with no lease-state mutation — this is exactly R1's stated
"at minimum" bar ("add a test where `readHead` returns a different value on a second call...").

What R1 flagged as the deeper issue — `withWorktreeLock` is process-local, so nothing here prevents a
*second* Tachyon host process or an out-of-band `git` operation from moving HEAD between this process's
recheck and its `store.update` commit — is **not** closed by this diff, and no comment/doc was added
recording it as a known cross-process gap (R1's alternative "at minimum" option). This is unchanged from R1's
own assessment that "this is not a T5 regression" and is scoped to a future cross-process concern. Given the
task's framing that real acquisition is presently fully blocked by `DELIVERY_LEASE_UNAVAILABLE`
(`leaseService.ts:91-93`, verified unconditionally first in `acquireInternal`) on every host until process-fence
support lands, and that R1 itself treated a test-only closure as sufficient, I accept this as MEDIUM,
non-blocking, tracked for whoever wires up `withWorktreeLock` to a real cross-process primitive alongside
process-fence support — not a defect in what T5 claims today.

## F6 — LOW — bare `.`/empty owns entry accepted as a literal scope — **CLOSED**

`normalizeOwns` (`leaseService.ts:309-315`) now rejects `entry === "."` alongside the existing
`!entry`/`".."`/`"../"`/absolute-path checks. Reproduced empirically: `ownsSubset: ["."]` now throws
`DeliveryLeaseError{code: "DELIVERY_OWNS_WIDENING"}` instead of being silently normalized and recorded.

## F7 — LOW — stale `reservationNonce` survives on a `held` lease holder — **CLOSED**

`confirmHeldInternal`'s mutate callback now rebuilds `holder` explicitly
(`leaseService.ts:222-231`: `{ segmentId, executionAgent, ...(principal ? {...} : {}), process }`) instead of
spreading the prior holder object, so `reservationNonce` is dropped on transition to `held`. Directly
asserted by `deliveryLeaseService.test.ts:99`: `expect(held.lease.holder).not.toHaveProperty("reservationNonce")`.

## F8 — LOW — invariant thrown as raw `DeliveryInvariantError` — **unchanged, per R1's own "none blocking"**

`leaseService.ts:129` (`"a successor acquisition requires a closed predecessor segment"`) is untouched. R1
explicitly said no closure was required here ("consider... or leave as an intentionally-loud invariant
crash"); leaving it as-is is a valid disposition, not a regression.

## New surface introduced by the fix — adversarial checks

- **operationId collision/intent confusion**: both `acquire`'s and `confirmHeld`'s receipts are written via
  the *same* `store.update(..., {operationId, ...})` path, so `getOperationResult(operationId, "update",
  deliveryId)` cannot distinguish "this operationId belongs to an acquire" from "...a confirmHeld" by kind
  alone. Verified this is still safe: reusing one `operationId` across an `acquire()` and a subsequent
  `confirmHeld()` on the same delivery does not silently cross-replay — `replayConfirmation` requires a
  matching `lease_held` event with that `operationId`, which won't exist in the acquire's receipt snapshot,
  so it fails closed with `DeliveryInvariantError`. Also verified an operationId reused with a *different*
  deliveryId is rejected inside `getOperationResult` itself (`store.ts:161-163`), and an operationId reused
  with the *same* deliveryId but different call arguments (e.g. different `executionAgent`) is rejected by
  the `isDeepStrictEqual` intent mismatch in `replayAcquire`. All three collision shapes throw
  `DeliveryInvariantError` rather than corrupting state or granting a mismatched replay.
- **Replay after later Delivery mutations / stale `result_json` semantics**: `getOperationResult` returns the
  frozen `result_json` from the moment that specific operation committed, not the delivery's current state.
  Verified this is safe by construction: acquired → confirmed → released → re-acquired by a second caller,
  then replayed the *original* (now stale) `operationId`. The replay correctly returns the old, stale
  snapshot (`version` behind current, distinct `reservationNonce` from the current holder's), and a follow-up
  `confirmHeld` using that stale replayed nonce is correctly refused (`WORKTREE_OCCUPIED`) against the
  *current* state — the stale replay cannot be leveraged to act against a later, unrelated segment.
- **F3 errors before inner catches**: confirmed the outer try/catch in both `acquire()` and `confirmHeld()`
  (not just the inner ones around `store.update`) is what actually guarantees F3's closure — a
  `DeliveryStoreBusyError` from the pre-lock `getOperationResult` replay check is caught and translated too.
- **confirmHeld CAS under real contention**: confirmed via two independent `DeliveryStore` instances (no
  shared JS lock) racing `confirmHeld` for the same nonce — exactly one winner, one structured retryable
  `WORKTREE_OCCUPIED` loser, no unstructured error and no double-commit.

## Regression check

`npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts` — 12/12 pass, unmodified,
run against `43c02bd` in an isolated `git worktree`. `npx tsc --noEmit` clean. `npm run verify:full` intentionally
not run per this review's constraints.

## Gate assessment

All eight R1 findings are closed or acceptably dispositioned:

- F1, F2, F3, F6, F7 — closed in code and covered by the shipped or reproduced tests.
- F4 — closed in code and verified by direct reproduction; the specific regression test R1 asked for is
  still missing (LOW, non-blocking — recommend adding it in a follow-up, not a re-review gate).
- F5 — the in-process window is closed and tested per R1's stated minimum bar; the cross-process concern
  remains open but was never a T5 regression and is moot while `DELIVERY_LEASE_UNAVAILABLE` blocks every real
  acquisition on this host.
- F8 — intentionally unchanged, matching R1's own "none blocking" guidance.

The T5 gate — "concurrent acquire grants one Delivery lease and returns retryable WORKTREE_OCCUPIED to the
loser" — now also holds for the realistic failure modes R1 identified (operation-receipt retry and genuine
SQLite lock contention), not just the in-process version-staleness race the original test constructed. No
new HIGH/MEDIUM defect was found while probing the new replay machinery's own attack surface (operationId
collision, stale-replay exploitation, error-translation ordering). **ACCEPT.**

## Commands used

```
npm ci                                                          # main worktree, per primer
git worktree add --detach <scratch>/wt-43c02bd 43c02bd
ln -s <main>/node_modules <scratch>/wt-43c02bd/node_modules
npx vitest run test/unit/deliveryLeaseService.test.ts           # 6/6 pass
npx vitest run test/unit/deliveryStore.test.ts test/unit/deliveryLeaseService.test.ts  # 12/12 pass
npx tsc --noEmit -p .                                            # clean
node _scratch_bundle2.mjs   # single combined esbuild bundle of store.ts + leaseService.ts (avoids dual-module-instance artifact)
node _scratch_probe.cjs     # F1, F2, F3, operationId-collision (acquire/confirmHeld), F6
node _scratch_probe2.cjs    # busy error from pre-lock replay path; stale-replay-after-later-mutations safety
node _scratch_probe3.cjs    # F4: concurrent confirmHeld across two independent store instances
node _scratch_probe4.cjs    # operationId reuse with mismatched intent (different executionAgent)
```

Bundling/probe scripts are scratch-only (session scratchpad and a detached `git worktree` outside the
review branch); no product or test file was modified. `npm run verify:full` was intentionally not run per
this review's constraints.
