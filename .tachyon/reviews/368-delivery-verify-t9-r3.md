# SDD 368 T9 adversarial review R3 — FINDINGS

Reviewed immutable correction range `8e68d23..6130c7bffe9fbcdf9fbbe766e29233b97fdceec4` against R2 and the binding R2 correction contract at `8621220`.

## Findings

### P2 — Rollback/close failures are not composed and can hide transaction uncertainty or replace the primary error

Evidence: `withVerificationPublicationTransaction` catches a failure after `BEGIN IMMEDIATE`, attempts `ROLLBACK`, and silently discards any rollback exception (`src/bridge/verifyTask.ts:619-626`). It then executes `database?.close()` unguarded in `finally` (`src/bridge/verifyTask.ts:627-629`). A close exception thrown while the function is already propagating a conflict, write/fsync/rename/directory-fsync, COMMIT, or rollback failure replaces that earlier error under JavaScript `finally` semantics. Conversely, a rollback failure is hidden if close succeeds, so callers are told only the primary publication failure even though explicit rollback could not be established. This violates the requested transaction lifecycle/error preservation boundary and makes a conflict or publication error indistinguishable from lock-domain cleanup uncertainty.

Required fix: track the primary, rollback, and close failures explicitly and surface them in stable causal order without allowing `finally` to replace earlier evidence. A failed COMMIT must still attempt rollback; rollback and close failures must be retained (for example in an `AggregateError`). Add injected lifecycle regressions for BEGIN failure, fn/conflict failure plus rollback failure, COMMIT failure, and primary/rollback plus close failure. Confirm busy errors remain wrapped as clear publication-unavailable failures with the original cause.

### P2 — The two-process regression does not deterministically exercise the former check-to-rename race

Evidence: both children signal readiness before waiting on one shared start file, but after release each independently enters the complete writer (`test/helpers/verificationPublisherChild.ts:6-10`; `test/unit/verifyTask.test.ts:180-208`). There is no barrier after both processes have read the canonical target and before either rename. Ordinary scheduling may let alpha finish the entire publication before beta enters the conflict check; that sequential execution produces the expected one-winner/one-conflict result even if the new SQLite transaction is removed and the old vulnerable check-then-rename writer is restored. The test uses the real writer and real separate processes, but it is not a forcing regression for the race it claims to close.

Required fix: add a test-only synchronization seam inside the real writer after conflict validation (or an equivalent deterministic process protocol) so both children are proven to reach the old vulnerable window concurrently. The fixed implementation should block the second process before that seam because of `BEGIN IMMEDIATE`; a deliberately lock-free/check-then-rename implementation must fail the test. Preserve the final assertions that exactly one succeeds and the winner's returned bytes remain canonical.

## Confirmed closures

- R2 P1 is closed in production: the complete target conflict check, same-scope decision, sibling-temp publication, rename, and directory fsync run under a workspace-local SQLite `BEGIN IMMEDIATE`. Different legacy identities cannot overwrite one another once they enter this critical section; same-scope replacement remains supported.
- R2 P2 is closed in the file writer: ownership begins only after exclusive `wx` succeeds; an open collision preserves the unowned sibling; later cleanup touches only the owned temp; primary and owned-temp cleanup errors are composed in stable order.
- SQLite uses a bounded five-second timeout, DELETE journal mode, FULL synchronous mode, short synchronous work only, COMMIT on success, rollback attempt on failure, and close in all paths. Process death releases the SQLite lock without an application lock row or stale-lock policy.
- Target unreadability/different identity refuses under the transaction; repeated same-scope verification, valid orphan retry, atomic temp ordering, and platform-specific directory-fsync behavior remain green.

## Verification

- Focused serial matrix: `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts test/unit/deliveryVerificationLease.test.ts test/unit/verifyTask.test.ts test/unit/bridge.test.ts test/unit/auth.test.ts test/unit/workspaceHeadless.test.ts test/unit/worktree.test.ts test/unit/gitDelivery.test.ts --maxWorkers=1` — PASS (9 files, 258 tests).
- `npm run typecheck` — PASS.
- `git diff --check 8e68d23..6130c7bffe9fbcdf9fbbe766e29233b97fdceec4` — PASS.
- `npm run verify:full` — PASS (300 files, 3357 passed, 3 skipped).
- Review remained read-only for production and tests. Pre-existing `tachyon.yml` modification was preserved and excluded from the review commit.

## Verdict

FINDINGS
