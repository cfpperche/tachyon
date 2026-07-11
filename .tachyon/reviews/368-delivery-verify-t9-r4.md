# SDD 368 T9 adversarial review R4 — ACCEPT

Reviewed immutable correction range `485d50a..d3f07585e467205458e5230a9dba992e3588c235` against R3 and the binding lifecycle/forcing contract at `5620797`.

## Review result

No actionable findings.

- Transaction initialization, PRAGMAs, and `BEGIN IMMEDIATE` are one explicit stage. A failure there becomes the sole clear `verification record publication unavailable` primary with its original `cause`, and an opened database is still closed (`src/bridge/verifyTask.ts:610-634`, `647-655`).
- After BEGIN, callback/conflict/write failures and COMMIT failures remain primary. Every uncommitted begun transaction attempts ROLLBACK; rollback failure is retained after primary. Close is always attempted and retained after rollback. No `finally` throw can replace an earlier failure (`src/bridge/verifyTask.ts:635-655`).
- Failure order is exact and stable: primary, rollback, close. One failure is thrown directly; combinations use `AggregateError`. A successful COMMIT plus close-only failure surfaces that close error instead of reporting success. BEGIN/busy failures preserve the underlying cause.
- The R3 lifecycle regressions cover busy BEGIN plus close, callback/conflict plus rollback, COMMIT plus rollback, and primary plus rollback plus close with exact identity/order assertions (`test/unit/verifyTask.test.ts:279-344`). The code structure also covers initialization-only and successful-COMMIT/close-only branches without a replacement path.
- The two real child processes both mark `calling` before publication. The first process to pass conflict validation writes its post-check marker and pauses while still holding `BEGIN IMMEDIATE`; the parent proves the second marker remains absent, then releases the winner. The loser subsequently observes the winner's different identity and returns `VERIFICATION_RECORD_CONFLICT` without reaching the hook (`test/helpers/verificationPublisherChild.ts`; `test/unit/verifyTask.test.ts:180-229`).
- This protocol distinguishes the fix: without SQLite serialization both children would pass the absent-target check, both would write post-check markers and block before rename, and the bounded absent-second-marker assertion would fail. With serialization, exactly one publishes and its returned bytes remain canonical.
- SQLite crash release, bounded busy handling, same-scope replacement, different-identity refusal, owned-temp cleanup, and the prior T9 crash/orphan/scope regressions remain intact.

## Verification

- Focused serial matrix: `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts test/unit/deliveryVerificationLease.test.ts test/unit/verifyTask.test.ts test/unit/bridge.test.ts test/unit/auth.test.ts test/unit/workspaceHeadless.test.ts test/unit/worktree.test.ts test/unit/gitDelivery.test.ts --maxWorkers=1` — PASS (9 files, 262 tests).
- `npm run typecheck` — PASS.
- `git diff --check 485d50a..d3f07585e467205458e5230a9dba992e3588c235` — PASS.
- `npm run verify:full` — PASS (300 files, 3361 passed, 3 skipped).
- Review remained read-only for production and tests. Pre-existing `tachyon.yml` modification was preserved and excluded from the review commit.

## Verdict

ACCEPT
