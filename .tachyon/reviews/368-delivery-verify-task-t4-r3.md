# SDD 368 T4 adversarial review round 3 — `4a68dfc`

**Verdict: ACCEPT** (one LOW-severity, non-blocking advisory finding)

## Scope

Delta review of `7b116b9..4a68dfc` (`fix(t-0b5723): recognize every historical delivery occupant, not just
first/tail`), written specifically to close prior review [`ba9a982`](368-delivery-verify-task-t4-r2.md)'s
**G1** (HIGH — legacy `DelegationRecord` `reuse_worktree` fixer rounds invisible to the self-waiver guard
and to liveness/lock/doorbell checks) and **G2** (MEDIUM — the waiver guard recognized only the first and
tail Delivery occupant, letting an interior segment self-waive). This round re-verifies both closures
against the actual call chains, checks for regressions in artifact hash/path compatibility, resolved-caller
authorization, current-tail operational selection, legacy fixer ordering, and duplicate/empty/malformed
occupant handling, and — departing from R1/R2, which were static-only — ran the relevant test suites plus
one targeted mutation experiment to prove the tests are load-bearing, not merely present. Read-only:
no production or test files were modified in the review target; `npm run verify:full` was not run (per
constraint). All test/typecheck runs below were narrow and used the already-`npm ci`'d sibling worktree at
`.../worktrees/b349073a/deliveryVerifyTaskT4` (pinned to `4a68dfc`), never the review branch.

## G1 — confirmed closed

`resolveVerificationTarget`'s legacy branch (`src/bridge/verifyTask.ts:184-201`) now derives:

```ts
const fixerOccupants = (record.fixerAttempts ?? []).map((attempt) => attempt.occupantAgent);
const canonical = fixerOccupants.length > 0 ? fixerOccupants[fixerOccupants.length - 1]! : record.agent;
...
identity: { legacy: record.agent, canonical, occupants: [record.agent, ...fixerOccupants], ... }
```

- `occupant = identity.canonical` (`verifyTask.ts:653`) now correctly names the live fixer for
  `isAgentRunning`, `withWorktreeLock`, the doorbell check, and `record.agent` on the persisted record —
  verified by running the new regression test live: `isAgentRunning`/`withWorktreeLock` were invoked with
  `"fixer-1"`, never `"worker"` (the exited original), and `agent_still_running` fired correctly.
- `assertWaiverAuthorized` now checks `identity.occupants.includes(caller.name)` — the live fixer, calling
  as its own resolved identity, is refused (`SELF_WAIVER_FORBIDDEN`) before any verification artifact is
  written (`fs.existsSync(.tachyon/verifications)` asserted `false` post-throw).
- `record.agent`/`record.owns`/`record.baseSha` (the scope-checker's anchor, `scopeBreachBlockers`) are
  correctly left bound to the raw `DelegationRecord` — only the operationally-relevant identity moved.

**Verified genuinely, not just read**: I reverted the src tree to `7b116b9` (pre-fix) in a scratch worktree,
copied over 4a68dfc's test file unchanged, and re-ran the two new tests — both fail at `7b116b9` exactly as
G1/G2 describe (`SELF_WAIVER_FORBIDDEN` never thrown; the interior-segment waiver silently succeeds). At
`4a68dfc` both pass. This proves the tests actually exercise the bug the commit claims to fix, not a
vacuously-true assertion.

## G2 — confirmed closed

`DeliveryIdentity.occupants` (`src/delivery/verifyAdapter.ts`) is now `delivery.segments.map(s =>
s.executionAgent)`, built only after `resolveOperationalSegment` has already proven contiguous, unique,
single-open-tail segments (fail-closed, unchanged from F2/R1). The new 3-segment test
(`worker`/`fixer-1`/`fixer-2`) independently exercises all three roles: the interior (`fixer-1`), the first
(`worker`), and the tail (`fixer-2`) are each individually refused a self-waiver; a `coordinator` caller
passes, and `record.identity.occupants` is asserted to be `["worker", "fixer-1", "fixer-2"]` in chronological
order. Storage-level check: `DeliveryStore` persists segments as a single JSON blob per delivery
(`record_json`, `src/delivery/store.ts:142-146`) round-tripped through `JSON.parse`/`structuredClone` — no
SQL re-ordering risk between write and `occupants` construction.

## Regression / compatibility sweep (unaffected by this delta, re-checked)

- **Artifact hash/path compatibility**: `verificationScopeKey` and `verificationRecordPath`
  (`verifyTask.ts:508-531`) were not touched by this commit and do not reference `identity.occupants` —
  confirmed by diff. An old on-disk record (written before `occupants` existed) still produces the same
  scope key as a fresh re-verification of the same delivery/segment, so re-verification overwrites rather
  than false-conflicting; two different deliveries at the same `refSha` still land at distinct
  hash-scoped paths. No behavior change here.
- **Duplicate/empty/malformed occupant identity**: duplicate names in `occupants` (e.g. a delivery that
  hands the worktree back to its original agent: `[worker, fixer-1, worker]`) are handled correctly —
  `Array.includes` doesn't care about duplicates. An empty/falsy `caller.name` short-circuits
  `assertWaiverAuthorized` before the `occupants` list is even consulted (`!caller.name` guard), so a
  malformed empty occupant entry can never be exploited as a matching caller name. Malformed/duplicate
  Delivery segments (bad indices, duplicate ids) are rejected before `occupants` is ever built, by the
  pre-existing `resolveOperationalSegment` fail-closed checks (unchanged, re-confirmed).
- **Resolved caller authorization / current-tail operational selection**: no other production call site
  references `identity.canonical`/`identity.legacy`/`identity.occupants` outside `verifyTask.ts` and
  `verifyAdapter.ts` (repo-wide grep) — the fix has no missed consumer.
- **Full relevant suite green** (ran directly, not merely read): `verifyTask.test.ts` (48/48),
  `deliveryVerifyTaskT4Behavior.gen.test.ts`, `verifyGate.integration.test.ts`, `deliveryStore.test.ts`
  (12/12) all pass at `4a68dfc`. `tsc --noEmit` is clean (exit 0).

## FINDING — LOW (advisory, non-blocking) — the G1 regression test can't distinguish "last fixer round" from "first fixer round"

The G1 test (`test/unit/verifyTask.test.ts`, `"a legacy delegation's reuse_worktree fixer cannot
self-waive..."`) grants exactly **one** `reuse_worktree` round (`fixerAttempts: [{ occupantAgent:
"fixer-1", ... }]`). With only one entry, `fixerOccupants[fixerOccupants.length - 1]` and
`fixerOccupants[0]` are the same element — the test cannot tell "last round wins" (what G1 actually asks
for and what the code correctly implements) apart from "first round wins forever" (a different, and for a
2+-round chain, wrong, selection rule).

**Verified, not hypothetical**: I mutated `src/bridge/verifyTask.ts` at `4a68dfc` to select
`fixerOccupants[0]` instead of `fixerOccupants[fixerOccupants.length - 1]`, and reran the full
`verifyTask.test.ts` suite — **all 48 tests still pass**, including the G1 test. A regression that silently
reverted to "the canonical occupant is always the *first* fixer round, not the latest" (which would reopen a
variant of the exact hazard G1 fixed, the moment a delegation accumulates a second `reuse_worktree` round)
would ship undetected by this suite today.

Current production behavior is correct (confirmed by reading `verifyTask.ts:200-201` — it uses
`fixerOccupants.length - 1`, the right index), so this is not a live defect and does not block acceptance.
Recommend a small follow-up: extend the G1 test (or add a second) with **two** `reuse_worktree` rounds
(e.g. `fixer-1` then `fixer-2`) and assert `canonical`/`occupant` resolve to `fixer-2`, not `fixer-1` — the
same ordering rigor the G2 test already applies to Delivery segments.

## Gate assessment

G1 and G2 are both closed in production code, exercised by tests that were shown live (not just read) to
fail at `7b116b9` and pass at `4a68dfc`, with no regression found in artifact identity/hashing, path
scoping, caller authorization, tail selection, ordering, or duplicate/malformed-input handling. The one
finding above is a test-suite completeness gap, not a code defect — it does not reopen G1 or G2 today.
Recommend accepting T4 as delivered; file the two-round ordering test as a fast follow, not a blocker.

## Focused commands run

```
git log --oneline 7b116b9..4a68dfc
git show 4a68dfc                              # full commit diff (verifyTask.ts, verifyAdapter.ts, tests)
git show 4a68dfc:src/bridge/verifyTask.ts
git show 4a68dfc:src/delivery/verifyAdapter.ts
git show 4a68dfc:src/bridge/delegationRecord.ts
git show 4a68dfc:src/bridge/tools.ts           # verify_task registration wiring, ~L1005-1067
git show 4a68dfc:test/unit/verifyTask.test.ts
grep -rn "\.canonical\b|\.legacy\b|\.occupants\b" --include=*.ts src/    # no missed consumers outside the two files
grep -rln "verifyAdapter|DeliveryIdentity|VerifyTaskIdentity" test/      # only verifyTask.test.ts

# ran against the pre-installed sibling worktree pinned at 4a68dfc (.../worktrees/b349073a/deliveryVerifyTaskT4):
node_modules/.bin/vitest run test/unit/verifyTask.test.ts                                     # 48/48 pass
node_modules/.bin/vitest run test/unit/deliveryVerifyTaskT4Behavior.gen.test.ts \
  test/unit/verifyGate.integration.test.ts test/unit/deliveryStore.test.ts                     # 12/12 pass
node_modules/.bin/tsc --noEmit                                                                 # exit 0

# truthfulness proof: reverted src to 7b116b9, kept 4a68dfc's test file, reran the two new tests -> both FAIL
git worktree add --detach <scratch> 7b116b9
git show 4a68dfc:test/unit/verifyTask.test.ts > <scratch>/test/unit/verifyTask.test.ts
node_modules/.bin/vitest run test/unit/verifyTask.test.ts \
  -t "reuse_worktree fixer cannot self-waive|refuses a self-waiver from an interior segment"   # 2 failed (expected)

# mutation proof of the LOW finding: fixerOccupants[fixerOccupants.length-1] -> fixerOccupants[0] at 4a68dfc
sed -i 's/fixerOccupants\[fixerOccupants\.length - 1\]!/fixerOccupants[0]!/' src/bridge/verifyTask.ts
node_modules/.bin/vitest run test/unit/verifyTask.test.ts                                      # 48/48 STILL pass
```

No production or test files were modified in the review target (`tachyon/deliveryVerifyTaskT4`); the
mutation/revert experiments above ran in disposable scratch worktrees that were removed afterward.
