# SDD 368 T9 adversarial review R2 — FINDINGS

Reviewed immutable correction range `7842960..9411df8f1ea12338e38cba822d64edf44bbf7eb2` against R1 and the binding correction contract introduced at `fa150f5`.

## Findings

### P1 — Conflict identity is still check-then-replace, so concurrent different verifications can overwrite each other

Evidence: `writeVerificationRecord` reads and validates the canonical target before creating its sibling temp (`src/bridge/verifyTask.ts:598-617`), then later performs an unconditional `renameSync(temporary, file)` (`src/bridge/verifyTask.ts:619-633`). On POSIX that rename atomically replaces whatever is at `file`; it does not assert that the file is still absent or still contains the same verification identity checked earlier.

Concrete interleaving: two legacy `verifyTask` calls for different delegation identities land the same `refSha`, so both target the legacy `<refSha>.json` path (`src/bridge/verifyTask.ts:587-595`). Both observe the path absent and pass the conflict check. Each exclusively writes/fsyncs its own sibling temp. A renames and returns its ACCEPT/BLOCKED record; B then renames over A and also returns success. A's returned `recordPath` now contains B's identity and integrity hash, violating the correction contract's requirement that a different identity is never overwritten. The existing regression is sequential—the first verification fully publishes before the second starts—so it proves only the no-race branch (`test/unit/verifyTask.test.ts:528` onward). Canonical Delivery names are hash-scoped and lease-serialized, but the writer is shared with the explicitly preserved legacy path, whose different agents use distinct worktree locks and can publish concurrently.

Required fix: make conflict decision and publication one serialized/atomic operation per canonical record path, including across processes. An absent target must be installed with no-replace semantics; replacement must occur only after atomically establishing that the current canonical bytes still belong to the same `verificationScopeKey`. Add a deterministic barrier test with two different legacy identities at one SHA: exactly one may publish, the loser must receive `VERIFICATION_RECORD_CONFLICT`, and the winner's returned record must remain byte-for-byte canonical.

### P2 — Failure cleanup can delete a temp this call never created and can mask the publication error

Evidence: the temp is opened with correct exclusive `"wx"` semantics, but the catch path always executes `fs.rmSync(temporary, { force: true })` regardless of whether `openSync` succeeded (`src/bridge/verifyTask.ts:619-639`). If the exclusive open fails because that exact sibling already exists, this call deletes the pre-existing file even though it never owned it—contrary to “remove only the exact temporary pathname created by that call.” Separately, an `rmSync` failure replaces the original write/fsync/close/rename/directory-fsync exception, so the normal publication failure is not preserved as required.

Required fix: track successful exclusive creation and remove only when this call created the sibling. Wrap cleanup so the primary failure is preserved; if cleanup also fails, surface both (for example, an `AggregateError`) without claiming cleanup succeeded. Add regressions for an `openSync(..., "wx")` collision that preserves the pre-existing sibling bytes and for a rename/fsync failure followed by cleanup failure that retains both errors.

## Confirmed closures

- R1 P1's partial-canonical crash wedge is closed for a single writer: complete bytes are written to an exclusive sibling, file-fsynced, closed, renamed, and directory-fsynced on non-Windows platforms. A pre-rename failure cannot truncate the canonical target; valid post-rename orphan records are retryable.
- R1 P2 is closed: implementer/fixer/recovery authority is normalized and bounded before the grant=end optimization. Zero-write escaping, absolute, and widened scopes block before the runner.
- Direct `deliveryId` verification without the Workspace-owned lease service now fails inside exported `verifyTask`, while legacy agent-only behavior remains unchanged.
- Projection validation now includes exact Workspace identity and the drift regression refuses before checkout.
- Repeated same-Delivery verification and the single-writer orphan-record recovery path pass; normal file/fsync/close/rename/directory-fsync ordering is correct, and Windows explicitly skips only directory fsync.

## Verification

- Focused serial matrix: `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts test/unit/deliveryVerificationLease.test.ts test/unit/verifyTask.test.ts test/unit/bridge.test.ts test/unit/auth.test.ts test/unit/workspaceHeadless.test.ts test/unit/worktree.test.ts test/unit/gitDelivery.test.ts --maxWorkers=1` — PASS (9 files, 255 tests).
- `npm run typecheck` — PASS.
- `git diff --check 7842960..9411df8f1ea12338e38cba822d64edf44bbf7eb2` — PASS.
- `npm run verify:full` — PASS (300 files, 3354 passed, 3 skipped).
- Review remained read-only for production and tests. Pre-existing `tachyon.yml` modification was preserved and excluded from the review commit.

## Verdict

FINDINGS
