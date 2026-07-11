# SDD 368 T7 adversarial review R2 — FINDINGS

Reviewed immutable range `9e99604..71cb57a` on `tachyon/deliveryLeaseT7` against R1 and the binding T7 handoff contract in `docs/specs/368-delivery-worktree-leases/notes.md`.

## Findings

### P2 — Drain replay adopts the current mutable holder instead of fencing the holder captured by transaction A

Evidence: transaction A captures the complete predecessor holder but persists only its `executionNonce` in the `handoff_draining` event (`src/delivery/leaseService.ts:322-330`). On a retry after transaction A, `replayDrain` reads `delivery.lease.holder` from the current Delivery and accepts it whenever its nonce still matches the event (`src/delivery/leaseService.ts:455-464`). The returned current holder then becomes `predecessorHolder` and the baseline for fencing, final reservation, and quarantine (`src/delivery/leaseService.ts:309-350`, `361-386`, `422-436`).

Therefore a crash/lost response after transaction A followed by any mutation of `executionAgent`, `principal`, or `process` that preserves `executionNonce` is laundered into the replay baseline. The retried handoff can fence using the old nonce while structurally accepting the changed process identity and then reserve a successor. This violates the exact-same-holder requirement across drain, fencing, and replay (`notes.md:139-150`, `156-158`). The new mutation test is truthful only for the uninterrupted call: it mutates during `proveEmpty`, while the in-memory original holder still exists (`test/unit/deliveryLeaseService.test.ts:231-247`); it does not exercise a lost-response/restart replay of the drain receipt.

Required correction: persist the complete immutable predecessor holder (or a canonical structural digest plus sufficient holder data) in transaction A's durable receipt, and require the current draining holder to match that receipt before returning it from `replayDrain`. Add a deterministic test that commits drain, simulates loss/restart, mutates a non-nonce holder field, and proves retry neither fences nor reserves a successor.

## Confirmed corrections

- A contender beginning after durable `draining` now receives retryable `WORKTREE_OCCUPIED`, with a deterministic pre-held-drain test (`src/delivery/leaseService.ts:390-400`; `test/unit/deliveryLeaseService.test.ts:211-229`).
- The uninterrupted handoff path compares the complete holder across transaction A, fencing, final reserve, and quarantine (`src/delivery/leaseService.ts:322-386`, `403-405`, `422-436`).

## Verification

- `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts --maxWorkers=1` — PASS (2 files, 27 tests).
- `npm run typecheck` — PASS.
- `npm run verify:full` — PASS (299 files, 3315 passed, 3 skipped).
- `git diff --check 9e99604..71cb57a` — PASS.
- Review remained read-only for production and tests.

## Verdict

FINDINGS
