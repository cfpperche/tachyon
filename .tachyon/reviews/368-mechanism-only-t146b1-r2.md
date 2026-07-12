# SDD 368 T14.6B1 mechanism-only lease policy — Sonnet R2 independent review — FINDINGS

Reviewed candidate `5ad06cf9` against R1 base `25bc5c3f`, journal contract `j-c5ab1ba949b4` (task `t-0b5723`),
the R2 correction contract `j-09ca6cbb5250`, and my own R1 report (`.tachyon/reviews/368-mechanism-only-t146b1-r1.md`,
commit `3c4aed75`). Read the full `25bc5c3f..5ad06cf9` diff (4 files, 109 insertions/23 deletions —
`leaseService.ts` 68 lines, three test files) and re-read the full current `leaseService.ts` replay/evidence
machinery. Ran `tsc --noEmit` (clean), the three directly-touched suites (147/147 pass), and `git diff --check`
(clean). Canonical `verify_task` for `5ad06cf9` recorded `accept` without `full`
(`.tachyon/verifications/5ad06cf93eaccdbe9ff120c9a3b808920e8ea908.json`), matching the R2 contract's "no full
until final combined closure."

**R1's two HIGH findings (H1, H2/H6) are correctly and precisely closed.** R1's H3 (severe matrix
undercoverage) is meaningfully improved but **still materially incomplete** — the coordinator's own stated
suspicion ("mechanism free acquire/review happy and stopper-outside-lock may still be absent despite 147 green")
is confirmed accurate on all three counts, plus two more gaps I found while checking the rest of the R2-requested
matrix.

## R1-H1 — CONFIRMED CLOSED correctly

A new `TransferAbsenceError` (`leaseService.ts:49-51`) carries both the full `ProcessFenceEmptyProof` (`proof`)
and any simultaneous `fenceError`. `establishTransferAbsence`'s `process-fenced` branch now throws this typed
error instead of a bare `Error` (`:1344-1350`), and `transferFailureEvidence` attaches `evidence.proof =
structuredClone(error.proof)` and `evidence.fenceError = ...` whenever the caught error is a
`TransferAbsenceError` (`:1375-1378`). I confirmed both new regression tests exercise exactly the two shapes R1
flagged: `test/unit/deliveryLeaseService.test.ts`'s new tests assert
`evidence.matchObject({ proof: { state: "survivors", pids: [7] } })` for the survivors case and
`{ proof: { state: "unknown", reason: "audit unavailable" }, fenceError: "freeze failed" }` for the simultaneous
unknown-proof+fence-error case — both run and pass. `pids` is no longer lost.

## R1-H2/H6 — CONFIRMED CLOSED correctly, including the incomplete-drain edge case

All three entry points (`acquireInternal`, `handoff`, `completeReview`) now run their completed-receipt replay
lookup **before** `assertSafetyEnabled`/`assertFenceCapability` (`leaseService.ts:506-512` acquire, `:704-709`
handoff, `:786-791` completeReview) — the exact ordering fix R1 recommended. The new
`replayIntentMatches(recorded, current, historicalSafety)` helper (`:1291-1299`) strips `handoffSafety` from
both sides before comparing when `historicalSafety` is `true`, so a completed receipt matches regardless of the
*current* safety setting — closing R1-H2 for real crash-recovery/double-submit retries across a safety
transition. I traced every call site: the three top-level "already completed" replay checks and both `catch`
blocks (`:775`, `:848`) all pass `historicalSafety = true`; the intermediate `replayDrain`/`replayReviewDrain`
calls (unchanged, `:704` in `handoff`, and `completeReview`'s equivalent) deliberately do **not** pass it,
so they still use strict `isDeepStrictEqual` including `handoffSafety` — meaning an *incomplete* drain retried
under a different current safety fails the strict match and throws `DeliveryInvariantError` ("does not match
this handoff drain intent") rather than silently re-stopping or switching evidence modes. This is exactly the
"incomplete drain whose stored safety differs from current must refuse explicitly" requirement from the R2
contract, and it falls out correctly from the historicalSafety=true/false split rather than needing separate
new logic. The new "replays completed acquire, handoff, and review receipts before disabled or unavailable
ambient safety checks" test (`deliveryLeaseService.test.ts`) forces this for all three entry points against a
`disabled`-with-non-callable-`capability` fixture, and passes.

## R3-H (undercoverage, continued) — confirm coordinator's suspicion on all three named gaps, plus two more

The R2 contract asked for a specific forcing matrix. Checking it row by row against what actually landed in this
diff:

- **"mechanism free acquire"** — **still zero coverage.** No test anywhere in this diff (or the R1 diff) calls
  `.acquire()` with `handoffSafety: "mechanism-only"`, happy or failure path. Confirmed absent, as the
  coordinator suspected.
- **"handoff+review happy paths"** — handoff happy path is covered (R1's original test, unchanged).
  **Mechanism-only `completeReview()` happy path is still zero coverage** — the only `completeReview` exercise
  anywhere in the suite uses the default `process-fenced` `reviewService()` factory. Confirmed absent, as the
  coordinator suspected.
- **"stop/observe outside locks"** — **still not empirically forced.** Every fixture in this diff and R1's
  (`withWorktreeLock: async (_path, fn) => fn()`) is a no-op passthrough with no exclusivity semantics, so no
  test could detect a regression that moved the `exactExecutionStopper.stop()`/`processObserver.observe()` calls
  inside a lock — there is nothing to fail if that ordering broke. I re-verified the ordering is still correct by
  reading source (`establishTransferAbsence` runs before `withDeliveryLock`/`withWorktreeLock` are acquired for
  the reserve CAS, same as R1), but this remains a source-read guarantee, not a test-forced one. Confirmed absent,
  as the coordinator suspected.
- **"alive/unknown/malformed/missing observer/stopper throw/missing stopper"** — the new `it.each` six-case
  table in `deliveryMechanismLeaseTerraR1Behavior.gen.test.ts` covers exactly these six shapes, but **only for
  `handoff()`** — not `acquire()` (which doesn't call `establishTransferAbsence` in mechanism-only mode at all,
  so this is moot for acquire) and not `completeReview()`, which does call it and has zero failure-path coverage.
- **"post-stop dirty/head drift"** — no new test covers a scenario where the exact-root stop+observe succeeds
  (`root_gone_best_effort`) but a subsequent worktree inspection then finds a dirty tree or moved HEAD. Not
  covered in this diff.
- **"same-Delivery CAS loser"** and **"strong freeze/terminate/prove call order"** — not newly exercised in this
  diff, but I did not find evidence either was newly broken; these look like they rely on pre-existing generic
  (safety-mode-agnostic) coverage from before B1, which is plausible but I did not independently re-verify it in
  this round since the contract's H3 ask was specifically about the *new* mechanism-only matrix.

Net: of the ~13 named matrix rows, this round added real, forcing coverage for structured-evidence preservation
(both branches), zero-ProcessFence-calls-in-mechanism (already had this from R1, reinforced by the new table),
and completed-replay-independent-of-current-safety for all three entries. It still has not added coverage for
mechanism-only `acquire`, mechanism-only `completeReview` (happy or failure), stop/observe-outside-lock as a
forcing property, or post-stop dirty/HEAD drift. This is a smaller gap than R1's (which had essentially zero
mechanism-only failure-path coverage at all), but it is not closed, and the two entry points now missing all
coverage are the same shape of risk R1's H1/H2 lived in — untested code paths that already caused two silent
regressions in this same file's `process-fenced` path this round.

## Verification run

- `tsc --noEmit -p tsconfig.json`: clean.
- `vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryMechanismLeaseTerraR1Behavior.gen.test.ts test/unit/deliveryMechanismOnlyLeaseT146B1Behavior.gen.test.ts`: **147/147 pass**.
- `git diff --check 25bc5c3f..5ad06cf9`: clean.

## Verdict

**FINDINGS.** R1's two HIGH regressions are correctly and precisely closed: structured `ProcessFenceEmptyProof`
evidence (including `survivors.pids` and simultaneous fence errors) now survives into quarantine records, and
completed-receipt replay for all three entry points (`acquire`/`handoff`/`completeReview`) now runs before the
safety/capability gate and correctly ignores the current `handoffSafety` while an incomplete drain retried under
a changed safety correctly refuses explicitly rather than silently switching evidence modes. R1's H3
undercoverage finding is only partially closed: the coordinator's own three named suspicions — mechanism-only
free acquire, mechanism-only review-completion happy path, and stop/observe-outside-locks as a forced (not just
source-read) property — are all confirmed still absent, and I additionally found mechanism-only `completeReview`
failure-path coverage and post-stop dirty/HEAD drift are also still missing. Recommend: do not close B1 yet;
add mechanism-only `acquire` and `completeReview` happy-path tests, extend the existing six-case failure table
(or an equivalent) to `completeReview`, add a lock-reentrancy-style test that would fail if
stop/observe moved inside `withDeliveryLock`/`withWorktreeLock`, and add a post-stop dirty/HEAD-drift case, before
requesting final combined closure.
