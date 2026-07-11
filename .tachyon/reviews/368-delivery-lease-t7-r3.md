# SDD 368 T7 adversarial review R3 — ACCEPT

Re-reviewed immutable range `9e99604..71cb57a` on `tachyon/deliveryLeaseT7`, specifically reconsidering the R2 replay finding against the DeliveryStore receipt implementation.

## R2 retraction

The P2 finding in `.tachyon/reviews/368-delivery-lease-t7-r2.md` is retracted. It incorrectly treated `DeliveryStore.getOperationResult` as returning the current Delivery. In fact, `getOperationResult` reads and parses the operation receipt's immutable `result_json` (`src/delivery/store.ts:150-165`). The update transaction writes that committed snapshot into `delivery_operation_receipts` atomically with the Delivery mutation (`src/delivery/store.ts:266-282`, `399-416`).

Consequently, `replayDrain` receives the transaction-A snapshot and returns its original complete holder (`src/delivery/leaseService.ts:455-464`), not the current mutable holder. If the live draining holder is later changed while preserving `executionNonce`, the original receipt holder remains the fencing baseline and the final `assertExactHolder` structural comparison rejects the drift before successor reservation (`src/delivery/leaseService.ts:309-350`, `357-386`, `403-405`). The same exact-holder requirement protects quarantine (`src/delivery/leaseService.ts:422-436`). There is no bypass on the path alleged by R2.

## Review result

- Durable in-flight `draining`, `pending`, and `verifying` states produce retryable `WORKTREE_OCCUPIED`; quarantined and genuinely invalid states remain fail-closed and non-retryable (`src/delivery/leaseService.ts:390-400`).
- The complete predecessor holder is captured before transaction A, retained in the immutable drain receipt, replayed from that receipt after response loss, and compared structurally across fencing, final reservation, and quarantine.
- The new tests truthfully cover a contender starting after durable drain and an uninterrupted full-holder mutation during fencing (`test/unit/deliveryLeaseService.test.ts:211-247`). Store receipt tests and implementation establish the immutable replay premise.
- No production or test files were modified during review.

## Verification

- `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts --maxWorkers=1` — PASS (2 files, 27 tests).
- `npm run typecheck` — PASS.
- `npm run verify:full` — PASS (299 files, 3315 passed, 3 skipped).
- `git diff --check 9e99604..71cb57a` — PASS.

## Verdict

ACCEPT
