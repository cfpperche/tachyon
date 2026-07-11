# SDD 368 T7 adversarial review R1 — FINDINGS

Reviewed immutable range `00097a6..9e99604` on `tachyon/deliveryLeaseT7` against the T7 implementation contract in `docs/specs/368-delivery-worktree-leases/notes.md`.

## Findings

### P1 — A contender that observes the durable `draining` state receives the wrong, non-retryable refusal

Evidence: `src/delivery/leaseService.ts:315-323` reloads the current Delivery before CAS A and delegates state validation to `assertHandoffAuthority`; `src/delivery/leaseService.ts:398` maps every state other than `held`, including the expected in-flight `draining` state, to non-retryable `DELIVERY_INVALID_STATE`. The binding contract requires contenders after CAS A to immediately receive retryable `WORKTREE_OCCUPIED` (`notes.md:139-141`).

This is not limited to a CAS race: any request beginning after transaction A commits deterministically takes this path. A coordinator following the structured retryability signal will treat an ordinary in-progress handoff as a terminal contract/state error instead of waiting or retrying. The concurrency test at `test/unit/deliveryLeaseService.test.ts:198-208` is not truthful for this boundary because both calls start together and only asserts the CAS-loser schedule; it never pauses the winner after the drain receipt and starts a second request against an already-durable `draining` record.

Required correction: map observed `draining`/`pending` occupancy to retryable `WORKTREE_OCCUPIED` before fencing, while retaining non-retryable invalid-state handling for genuinely malformed/ineligible states, and add a deterministic pre-held-drain contender test.

### P2 — Final revalidation does not require the exact same predecessor holder

Evidence: the binding algorithm requires the exact same draining holder/execution nonce after fencing (`notes.md:149-152`). The implementation records only `segmentId` and `executionNonce` (`src/delivery/leaseService.ts:308-313`) and `assertExactDraining` checks only those two fields (`src/delivery/leaseService.ts:409-412`). It does not compare the durable process identity, execution agent, or principal captured before fencing. Consequently, a concurrent/recovery mutation that changes holder identity while retaining segment and nonce passes final revalidation, and CAS B closes the segment/reserves the successor on evidence produced for a no-longer-exact holder.

Required correction: capture and compare the complete predecessor holder identity (at minimum process identity plus segment and execution nonce) across CAS A, fencing, quarantine, and CAS B; add a deterministic mutation-between-fence-and-final-CAS test.

## Verification

- `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts --maxWorkers=1` — PASS (2 files, 25 tests).
- Review was read-only for production and tests. Full verification was intentionally not run because the routed contract requested focused tests only.

## Verdict

FINDINGS
