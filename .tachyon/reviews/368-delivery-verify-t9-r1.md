# SDD 368 T9 adversarial review R1 — FINDINGS

Reviewed immutable range `2b40537..c6a447ef9d0a802f64d47cfd2160a0a43395a4b2` on `main` against the binding T9 contract in `docs/specs/368-delivery-worktree-leases/notes.md` and the surrounding spec, plan, and tasks.

## Findings

### P1 — A crash during verification-record publication can permanently wedge an otherwise retryable Delivery

Evidence: canonical verification restores the delivered branch and then invokes `prepared.publish()` while the durable lease still remains `verifying` (`src/delivery/verificationLease.ts:142-160`). The production publisher writes the scoped record directly with `fs.writeFileSync(file, ...)` (`src/bridge/verifyTask.ts:597-619`), which opens/truncates the destination before the complete JSON is durable. On restart, the different-owner-epoch recovery accepts the clean delivered/temporary checkout, restores the prior lease, and records a retryable interruption (`src/delivery/verificationLease.ts:75-80`, `189-199`). But a retry reaches the same scoped record path, sees the partial file, fails JSON parsing, and treats it as an unowned conflict that must never be overwritten (`src/bridge/verifyTask.ts:589-615`). The Delivery is now `free`/`held` and explicitly retryable, yet verification cannot ever complete without manual deletion of the corrupt artifact.

Concrete crash reproduction: start a canonical verification through the real `verifyTask` publisher; after delivered-HEAD restoration, kill the process after the verification record has been opened/truncated but before the JSON write completes. Construct a fresh Workspace epoch and call verification once to recover the old lease, then retry. Recovery records `verification_interrupted`, while the retry throws `VERIFICATION_RECORD_CONFLICT` on the unreadable same-scope file. Current lifecycle tests replace `publish()` with an in-memory mock (`test/unit/deliveryVerificationLease.test.ts:103-106`, `180-187`), so they cannot exercise the production filesystem crash boundary.

Required fix: publish verification records through a same-directory unique temporary file and atomic rename only after the complete record is written (with the durability policy required for this crash-sensitive evidence), and safely identify/clean only this operation's abandoned temporary artifact. Add a production-path crash/recovery regression proving a partial publication cannot block the deliberate retry and cannot overwrite another verification identity.

### P2 — Invalid writer authority is skipped for a zero-write segment

Evidence: canonical segment verification classifies writer roles, then immediately skips the segment when `grantedHeadSha === end`; only afterward does it normalize `ownsSubset`, prove it is within the immutable contract, and emit `invalid_segment_scope` (`src/bridge/verifyTask.ts:475-489`). Therefore an `implementer`, `fixer`, or `recovery` segment with grant=end and `ownsSubset: ["../escape"]`, an absolute path, or widened authority is accepted. This contradicts the binding requirement that invalid/escaping authority fail closed before behavior tests (`notes.md:362-368`). The added malicious-scope tests all commit after the grant, so grant and end differ and the vulnerable early return is not exercised (`test/unit/verifyTask.test.ts:304-326`).

Required fix: normalize and validate every writer segment's authority before the zero-diff optimization; skip only the Git diff when grant=end. Add zero-write cases for escaping, absolute, and widened scopes and prove behavior execution is not invoked.

## Untested advisories

- A crash after the full verification record is renamed/written but before `verification_completed` persists leaves a valid orphan ACCEPT/BLOCKED artifact while next-epoch recovery records only `verification_interrupted`. No current production reader in this range treats the standalone file as canonical completion, so this is not raised as a bypass, but the missing publication marker/reconciliation should be explicitly tested before any consumer begins trusting record files without the matching Delivery event.
- `verifyTask` itself still permits a direct canonical `deliveryId` call without `deliveryVerification`; only the Bridge wrapper refuses the missing Workspace service (`src/bridge/verifyTask.ts:738-755`; `src/bridge/tools.ts:1096-1119`). There is currently no other production caller, but making the exported function fail closed would prevent a future internal caller from silently taking the legacy checkout path.
- `assertProjection` proves projection id, Delivery backlink, branch, and canonical realpath, but not `projection.workspaceId === delivery.workspaceId` (`src/delivery/verificationLease.ts:288-299`). The current stores are workspace-local, yet GitDelivery mutation does not make `workspaceId` immutable; exact projection identity should include it or document why the local-store boundary is sufficient.

## Confirmed controls

- The path mutex spans verifying CAS, every checkout/test, restoration, record publication, and lease completion; WorktreeManager canonicalizes the same path key used by ensure/remove.
- The SQLite version CAS selects one verifier, same-epoch verification refuses as occupied, and a live current tail—not segment zero—blocks verification.
- Checkout intent is persisted before each detached checkout; recovery distinguishes delivered, recorded temporary, dirty, and third-HEAD states and loudly composes quarantine-persistence uncertainty.
- Held holder/process/execution nonce and expected HEAD survive verifying and quarantine; normal completion restores the exact prior lease shape with a fresh timestamp.
- Legacy verification, waiver authorization, Delivery/segment-scoped record identity, and the three-segment linear/scoped happy path remain green.

## Verification

- Focused serial matrix: `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/deliveryStore.test.ts test/unit/deliveryVerificationLease.test.ts test/unit/verifyTask.test.ts test/unit/bridge.test.ts test/unit/auth.test.ts test/unit/workspaceHeadless.test.ts test/unit/worktree.test.ts test/unit/gitDelivery.test.ts --maxWorkers=1` — PASS (9 files, 249 tests).
- `npm run typecheck` — PASS.
- `git diff --check 2b40537..c6a447ef9d0a802f64d47cfd2160a0a43395a4b2` — PASS.
- `npm run verify:full` — PASS (300 files, 3348 passed, 3 skipped).
- Review remained read-only for production and tests. Pre-existing `tachyon.yml` modification was preserved and excluded from the review commit.

## Verdict

FINDINGS
