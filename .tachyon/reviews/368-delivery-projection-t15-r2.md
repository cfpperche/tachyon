# SDD 368 T15 canonical GitDelivery projection — Sonnet FINAL review — ACCEPT

Reviewed candidate `7d76f304` against BASE `e5a276ba` (fresh migrated branch off current main, post my R1
`313ffed1`), journal contract `j-4bf98b84203a` (task `t-0b5723`), and my original findings
(`.tachyon/reviews/368-delivery-projection-t15-r1.md`, F1-F4 correction contract `j-1946650984a1`). Read the full
`e5a276ba..7d76f304` diff (16 files, 2807 insertions/34 deletions), with targeted full-content reads of
`src/git-delivery/policy.ts`, the relevant sections of `src/git-delivery/store.ts` (`update`/`applyCanonicalIntent`/
`assertImmutableLink`), `src/delivery/projectionService.ts` (all three mutation entry points, `assertReplayIntent`,
`assertSafeForMutation`), the `bridge/tools.ts` caller-required refusal branches, and the migrated
`deliveryVerificationLease.test.ts` fixtures. Ran `tsc --noEmit` (clean), seven directly-touched suites
(130/130 pass), and `git diff --check` (clean). Canonical `verify_task` for `7d76f304` recorded `accept`, zero
findings, zero waivers (`.tachyon/verifications/7d76f304f312f3e57e533bc6814d6ddc96ab569d.json`) — a full run
already went green on the first fresh reviewable candidate per the coordinator's own extra-full authorization.

## F1 (HIGH, legacy blanket authority) — CONFIRMED CLOSED

`src/git-delivery/policy.ts`'s `canMutateLinkedGitDelivery` no longer has a `legacy` branch at all. It now
requires a `caller` argument (`if (!caller) return false;`), and only `system`/`human`/`master` caller kinds or a
principals-allowlisted `agent` caller grant authority. `actor` is renamed `_actor` (unused) — attribution can no
longer reach the authorization decision at all, not just in the one call site I originally found trusting it.

## F2 (HIGH, caller-omitted actor-equality bypass) — CONFIRMED CLOSED

`CanonicalIntegrateInput.caller` and `CanonicalPruneInput.caller` (`projectionService.ts`) are now non-optional
`Pick<CallerSnapshot, "kind" | "name">` fields — the type system itself prevents constructing a service call
without a caller. At the Bridge tool boundary, both `git_delivery_integrate` and `git_delivery_prune`
(`bridge/tools.ts:737-738`, `:811-812`) now explicitly check `if (!deps.caller) return fail(...)` before any
authorization or service call, closing the path my R1 review found reachable only via a hypothetical future
direct caller — now the type system and the one production entry point both refuse a missing caller before
reaching the policy check.

## F3 (MEDIUM, GitDeliveryStore.update missing linked-row guard) — CONFIRMED CLOSED

`GitDeliveryStore.update()` (`src/git-delivery/store.ts:153-172`) now throws
`GitDeliveryCanonicalSequenceError` unconditionally when `current.deliveryId` is set, before `mutate()` is ever
called — closing the gap left by R1's vestigial, unused `allowLinkedBypass` parameter (that parameter no longer
exists). I confirmed the intentional exception still works correctly: `open()`'s pre-link reservation path calls
`update()` only on a record whose `deliveryId` is *currently* unset (`existing.deliveryId` falsy at the call
site), so the guard doesn't fire and unlinked→linked compatibility is preserved. I also confirmed the two
previously-blocking `deliveryVerificationLease.test.ts` fixtures were migrated to use
`GitDeliveryStore.applyCanonicalIntent()` with a deliberate fresh operationId/sequence to inject drift for their
test scenarios, rather than bypassing the new refusal — a legitimate use of the canonical API, not a reintroduced
hole.

## F4 (HIGH, replay must match exact persisted intent) — CONFIRMED CLOSED

A new `assertReplayIntent` (`projectionService.ts:754-772`) is called at all three replay sites — `openCanonical`
(existing-open branch), `integrate` (existing-integrate branch), and `prune` (existing-prune branch) — before an
operationId match is treated as a valid idempotent replay. It compares `gitDeliveryId`, `action`, `actor` (deep
equality), and every caller-supplied key in the current call's `expected`/`payload` against the persisted
intent's recorded values, throwing `PROJECTION_SEQUENCE` ("retried with altered projection intent") on any
mismatch. I checked which fields are deliberately excluded from each comparison (e.g. `deliveryVersion`,
`baseRef`, `phase`, `integratedSha`) and confirmed they are all service-derived/observed context captured for
audit purposes at original-append time, not caller-supplied input — excluding them doesn't create a way to
smuggle a different effective operation through a matching operationId, since none of the fields an attacker or
a buggy caller could control are excluded from the comparison in any of the three call sites.

## Other named invariants — verified

- **Lock/sequence/T14 safety**: `assertSafeForMutation` is structurally unchanged from the architecture I
  verified sound in R1 (claim → worktree mutex → live checks → GitDelivery transaction order; held/quarantined/
  unavailable explicit refusal; non-terminal fail-closed fallback). Not touched by this diff's F1-F4 scope.
- **Unlinked legacy compatibility**: the Delivery-less `git_delivery_open`/`git_delivery_prune` branches and
  `canOpenGitDelivery`/`canPruneGitDelivery` (legacy Delivery-less policy) are untouched by this diff.
- **No scope breach**: `test/unit/auth.test.ts`'s tool-count assertion is now `61`, and I independently confirmed
  via `git show BASE:src/bridge/tools.ts` vs `HEAD:src/bridge/tools.ts` that exactly one new tool
  (`git_delivery_integrate`) was added in this range — the assertion is numerically correct, not just
  mechanically bumped. `test/unit/deliveryVerificationLease.test.ts` is now an intentionally-owned path per the
  F0/final-migration contract, consistent with why it's in this diff. Canonical `verify_task` recorded zero
  `scope_breach` findings.

## Verification run

- `tsc --noEmit -p tsconfig.json`: clean.
- `vitest run` on all seven directly-touched suites (`deliveryProjectionService`, `gitDelivery`, `deliveryStore`,
  `bridge`, `auth`, `deliveryVerificationLease`, and the generated `deliveryProjectionT15LunaFinalR2Behavior`
  suites): **130/130 pass**.
- `git diff --check e5a276ba..7d76f304`: clean.

## Verdict

**ACCEPT.** All four findings from my original review (`313ffed1`) are correctly and verifiably closed with
concrete source evidence, not just asserted: legacy-kind blanket authority is fully removed, linked-mutation
callers are non-optional at both the type and Bridge-tool-boundary level, `GitDeliveryStore.update()` now
unconditionally refuses any already-linked record, and replay at all three canonical entry points now validates
the complete caller-supplied intent before treating an operationId match as idempotent. I found no new concrete,
reproducible correctness/security/safety defect in this round. (Not raised as findings, per this round's binary
acceptance criterion: I did not independently re-verify the full test-rigor/matrix-coverage breadth of the new
`537`-line `deliveryProjectionService.test.ts` line-by-line in this pass, since my R1 review's test-rigor scope
was already satisfied and this round's contract explicitly excludes "more tests, style, or speculative hardening"
from blocking.) T15 is ready to close from my side.
