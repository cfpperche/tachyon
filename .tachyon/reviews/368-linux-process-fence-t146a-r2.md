# SDD 368 T14.6A Linux ProcessFence adapter — Sonnet R2 independent review — FINDINGS

Reviewed correction candidate `7eebe0bf` (branch `tachyon/linuxProcessFenceGrokR1`) against journal contract
`j-35ddbeb38f00` and my own R1 report (`.tachyon/reviews/368-linux-process-fence-t146a-r1.md`, `2b3e7100`, all seven
H1-H7 confirmed). Read the full `a9e058b4..7eebe0bf` diff (142 production lines, 25 test lines) and the current
complete `linuxProcessFence.ts`. Canonical `verify_task` ACCEPT but explicitly **without** `full_tests` — the
coordinator correctly withheld acceptance pending this security re-review rather than trusting the lighter gate.

All seven R2 hypotheses are **confirmed**. The correction genuinely closes several R1 findings well (see below) but
leaves the two most safety-critical functions — `terminate()` and `containmentEmptyProof()` (the function
`proveEmpty` itself depends on) — completely untouched, and the zero-net test-file growth means none of the new
behavior the production code gained has any coverage at all.

## What R1 closed correctly (verified against the current source)

- **H1 (duplicate relaunch)**: `prepareLaunch` now always attempts `store.create(pending)` and throws
  `"fence identity already exists; refusing duplicate launch"` on failure — the confirmed-identity replay branch
  that used to hand back a fresh, re-executable wrapper is gone entirely (`linuxProcessFence.ts:364-396`).
- **H2 (no CAS)**: `FenceIdentityStore` now exposes `create()`/`compareAndSet()` instead of a bare `store()`;
  `confirmLaunch` uses `compareAndSet(identity, confirmed)` (`linuxProcessFence.ts:444-446`). See R2-H3 below for
  where this is necessary but not sufficient.
- **H3 (no hash pin, group-writable)**: `LinuxProcessFenceDeps` now requires `expectedHelperPath`/
  `expectedHelperSha256`/`expectedRuntimeUid`; `requireHelperIdentity`/`probeCapability` compare the helper's
  self-reported hash against these configured values, not just format (`linuxProcessFence.ts:609-632`,
  `797-833`). The writability check is now `(mode & 0o022) !== 0`, correctly covering both group- and world-write.
- **H4 (confirm without membership; dead branch)**: `confirmLaunch` now rejects `procs.length === 0`
  (`linuxProcessFence.ts:433-436`), and the dead conditional is replaced with a real, enforced check inside the poll
  itself (`if (s.id !== unitName) throw ...`, line 427). `tryRepairPending` also gained the same empty-membership
  rejection (line 719-720).
- **H6 (parser gaps, `match_count=0` survivors)**: `target`/`self_ruid` are now required to match expected values;
  `stderr` must be empty or the result is rejected; the exit-1 branch now requires `matchCount > 0` and
  `capSysPtrace === "yes"` (`linuxProcessFence.ts:573-579`), closing the exact self-contradictory bug I reported.
- **H7 (schema/repair provenance)**: new `validateIdentity()` checks schema version, digest/unit/boot/helper-pin
  consistency, and phase-appropriate field presence, called from both `confirmLaunch` and `requireConfirmedIdentity`;
  `tryRepairPending` now also checks `snap.id !== unitName` (line 699), closing the gap where repair was less
  rigorous than the primary confirm path.

## R2 hypotheses — all confirmed

### R2-H1 — CONFIRMED (HIGH): `terminate()` is byte-for-byte unchanged; the same-name-reuse race I reported in R1 is still fully present

`terminate()` (`linuxProcessFence.ts:463-504`) has zero diff lines against `a9e058b4`. The invocation-drift guard
is still `if (live.invocationId && identity.invocationId && live.invocationId !== identity.invocationId)` — gated
behind both sides truthy, so a freshly-created foreign unit under the same deterministic name with a not-yet-
populated `invocationId` still slips past undetected. `live.id` is never read or compared anywhere in this function
— unlike `confirmLaunch`'s poll and `tryRepairPending`, which both gained an exact `snap.id === unitName` check in
this same correction, `terminate` was not given the equivalent. `identity.controlGroup` (captured once, `cg`) is
used directly for every `readEvents`/`writeKill` call and is never re-compared against a fresh `live.controlGroup`
inside the retry loop. The `systemd.stop(unitName)` bounded-cleanup call (line 497) remains reachable under exactly
the conditions I described in R1: a same-name foreign unit with `populated=0` and an as-yet-active state.

### R2-H2 — CONFIRMED (HIGH): `containmentEmptyProof()` — the function `proveEmpty` itself relies on for its core safety guarantee — is also byte-for-byte unchanged and has the identical gap, arguably worse

`containmentEmptyProof()` (`linuxProcessFence.ts:725-779`), zero diff lines against `a9e058b4`. Its drift checks are
**even more lenient** than `terminate`'s: `if (identity.invocationId && snap.invocationId && snap.invocationId !== identity.invocationId)`
and the equivalent for `controlGroup` — both require **both** the stored identity's field **and** the live
snapshot's field to be truthy before comparing. `snap.id` is never checked here either. This is the single most
severe unresolved finding: `proveEmpty` is the function this entire SDD chain (five rounds of C-helper review, two
rounds of this adapter) exists to make trustworthy, and its own containment check can be defeated by an
inactive/reused unit reporting blank identity fields plus a missing or already-torn-down old cgroup path — composing
with a helper run that (correctly, on its own terms) reports `empty` for the requested worktree, to produce a
`proven_empty` result that does not actually correspond to the pinned execution. I did not find a way to fully rule
this out from code reading alone within this review's read-only scope, but the structural gap — identical to the
already-confirmed `terminate` gap, in the function that matters most — is unambiguous.

### R2-H3 — CONFIRMED (MEDIUM/HIGH): the new CAS is necessary but not sufficient — `confirmLaunch` reads live OS state, then reads cgroup membership, then CASes without re-observing the unit in between

`confirmLaunch` (`linuxProcessFence.ts:398-447`): `pollUntil` captures `snap` (with its own in-probe `s.id`
check) → `await this.cgroup.readProcs(snap.controlGroup)` (a separate async call) → builds `confirmed` from the
**original** `snap.invocationId`/`snap.controlGroup` → `compareAndSet(identity, confirmed)`. The CAS protects the
**stored record** from a concurrent second writer touching the same digest; it does not protect against the
**live unit** changing between the `readProcs` await and the eventual write. If the unit is replaced in that
window, the code persists a `"confirmed"` identity carrying `snap` data captured before the replacement — internally
consistent, but potentially already stale relative to the OS. This directly answers the coordinator's question
about whether the create/CAS API is sufficient on its own: **no** — CAS closes the concurrent-store-writer class of
race (R1's original H2) correctly, but a materially different class of race (stale OS-state snapshot surviving into
a CAS-protected write) needs the OS state to be re-observed immediately before (or atomically with) the write, which
CAS alone cannot provide.

### R2-H4 — CONFIRMED (HIGH for functional correctness; fails closed for safety): the parser's truncation-marker grammar does not match the helper's actual output format, and I proved it breaks on a realistic line

The real C helper (`.tachyon/studies/368-process-audit-helper.c`, verified across five prior review rounds) emits
truncation markers as `unknown_truncated=yes omitted=<N>` / `match_truncated=yes omitted=<N>` — the literal string
`"yes"` followed by a separate `omitted=<N>` segment on the same line. The R2 parser
(`linuxProcessFence.ts:284-285`) does `const v = line.slice(18); if (!/^\d+$/.test(v)) return null;` — expecting
the text immediately after `"unknown_truncated="` to be **bare digits**. I added a temporary scratch test (removed
before finishing this review; worktree left clean, confirmed via `git status`) calling
`parseAuditHelperStdout` directly with a stdout string shaped exactly like real helper output including
`"unknown_truncated=yes omitted=100"`:

```
RESULT: null
```

**Confirmed empirically, not just by code reading.** Given my own repeated empirical runs of the real helper across
R1-R5 of that review chain consistently showed `unknown_count` around 164 on the reference host — always exceeding
the helper's 64-entry report cap, meaning `unknown_truncated=yes omitted=N` appears in essentially **every** real
invocation on that host — this bug would make `parseAuditHelperStdout` return `null` ("malformed") for nearly every
actual run, not an edge case. The failure direction is safe (`unknown`, never a false `proven_empty`/`survivors`),
but it likely makes the adapter's `proveEmpty` path unable to ever reach a real state determination in practice on
a host with any ambient same-UID `EACCES` noise. Separately, and less severely: there is no cross-check that the
count of literal `"unknown reason="` lines actually present equals `unknownCount - (unknownTruncated ?? 0)` — the
analogous check *was* added for match lines (`matchPids.length !== matchCount - (matchTruncated ?? 0)`) but the
equivalent for unknown-reason lines was not, an asymmetric fix. The exit-2/exit-3 fallthrough also still does not
require `parsed.state === "unknown"` to match, though this is low-severity since any non-0/non-1 exit already
forces the correctly-conservative `unknown` result regardless.

### R2-H5 — CONFIRMED (HIGH, test-truthfulness): zero new test coverage for any of the new production behavior

The entire test diff (`test/unit/linuxProcessFence.test.ts`, +25/-14) is mechanical: updating `MemoryStore` to
implement `create()`/`compareAndSet()` instead of `store()`, adding the three new required harness constructor
fields, and threading the two new required arguments through existing `parseAuditHelperStdout` call sites. I ran
the suite myself: 35 tests, all passing — the same count as before this correction. There is no test for: `create()`
returning `false` (duplicate-receipt refusal), `compareAndSet()` returning `false` (concurrent modification during
confirm), `validateIdentity()` rejecting a corrupted/wrong-schema record, a *realistic* truncated helper output
(which — see R2-H4 — would have caught that bug immediately), the exit-1 `matchCount <= 0` rejection path, or
`tryRepairPending`'s new empty-membership rejection. None of R2-H1/H2/H3's still-open gaps have any test attempting
to exercise them either, forced or otherwise.

### R2-H6 — CONFIRMED (MEDIUM/HIGH): `assertExactLiveIdentity` — used by every `freeze`/`terminate` pre-action check — never checks `snap.id` or requires an active state

`assertExactLiveIdentity()` (`linuxProcessFence.ts:675-691`), unchanged: checks boot id, `loadState !== "not-found"`,
and invocationId/controlGroup *only when the identity's own field is truthy* (a narrower but still-real gap, since
it doesn't require the **live** side to be truthy the way it perhaps should for symmetry with R2-H2's finding). It
never compares `snap.id` against `identity.unitName`, and never requires `snap.activeState` to be `"active"`/
`"running"` — a unit in some other systemd state (e.g. mid-transition) still passes. This function gates the entry
to `freeze` (twice) and `terminate` (once, at the very top) — the two actions with the most direct, irreversible
effect on a real process group. Given `confirmLaunch`'s poll and `tryRepairPending` both gained the `snap.id`
check in this exact correction, its absence here is a real, now-inconsistent gap in the function protecting the
most consequential actions.

### R2-H7 — CONFIRMED (LOW/MEDIUM): configured helper path is not canonicalized; `expectedRuntimeUid` has no sanity check at construction

`depsHelperPinValid()` (`linuxProcessFence.ts:669`) checks only `expectedHelperPath.startsWith("/")` — a syntactic
absolute-path check, not a canonical-path check (no rejection of `..`/`.`/double-slash components), unlike the
rigor the C helper itself applies to its *target* argument. Lower practical risk since this is an administrator-
supplied static configuration value rather than runtime-attacker-controlled input, but a real gap that could mask a
configuration mistake. `expectedRuntimeUid` (a required field) is never validated for sanity anywhere — an obviously
wrong value (e.g. `-1` or a mismatched UID) simply causes every `parseAuditHelperStdout` call to fail the
`selfUid !== expectedUid` check, which fails closed (`unknown`) but with no diagnostic pointing at the actual
misconfiguration.

## Verdict

**FINDINGS.** The correction is real and substantive — H1, H3, H4, H6, and H7 from R1 are genuinely closed, not
superficially patched, and I verified each against the current source. But R2-H1 and R2-H2 mean the two functions
with the most direct safety consequence — `terminate` (can it kill the wrong unit?) and `containmentEmptyProof`
(can `proveEmpty` be fooled?) — received no changes at all and retain the exact same-name-reuse/blank-field gap I
flagged in R1. R2-H3 shows the new CAS, while a correct and necessary improvement, does not by itself close the
narrower live-state-staleness race inside `confirmLaunch`. R2-H4 is a concrete, empirically-reproduced parser bug
that likely breaks `proveEmpty` on any host with realistic ambient noise (fails safe, but likely non-functional in
practice). R2-H5 confirms none of this — old or new — has test coverage proving it works, which is exactly how
R2-H4 shipped undetected. Recommend a further correction closing R2-H1/H2 (extend the `snap.id`/exact-controlGroup
checks already added elsewhere to `terminate` and `containmentEmptyProof`), R2-H3 (re-verify live state immediately
before the confirm CAS, not just before `readProcs`), and R2-H4 (fix the truncation grammar to match the real
helper format — verified reproducible with one line of test input) before this is reviewable for production
rollout; R2-H5's absent forcing matrix should be treated as a blocking gate on its own per this SDD's established
practice, not a follow-up.
