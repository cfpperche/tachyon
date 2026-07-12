# SDD 368 T14.6A Linux ProcessFence adapter — Sonnet R3 independent review — FINDINGS

Reviewed correction candidate `686566eb` (branch `tachyon/linuxProcessFenceGrokR1`) against journal contract
`j-baa85159f347` and my own R2 report (`.tachyon/reviews/368-linux-process-fence-t146a-r2.md`, `26a73883`, R2-H1
through R2-H7 all confirmed). Read the complete current `linuxProcessFence.ts` (863 lines) and the full
`7eebe0bf..686566eb` diff (203 production lines, 116 test lines). Canonical `verify_task` ACCEPT, no waiver, no
full (the coordinator again correctly withheld trusting the lighter gate pending this review).

**This is real, substantial progress.** R2's two most severe findings — `terminate()` and `containmentEmptyProof()`
(`proveEmpty`'s own dependency) being byte-for-byte untouched — are finally closed, via a shared exact-snapshot
validator architecture (`isExactSnapshotFor`/`sameSnapshot`/`isActiveDeterministicSnapshot`) exactly matching what
the R3 contract asked for. But the correction introduces three new regressions (all over-corrections that break
*legitimate* cases, not soundness holes) and the test-truthfulness problem from R2 persists in a new form.

## R2 closures verified

- **R2-H1/R2-H2** (terminate/containment same-name-reuse, blank-field bypass): `isExactSnapshotFor` now requires
  `snap.id === identity.unitName` **and** both `invocationId`/`controlGroup` to be non-blank **and** byte-equal to
  the pinned identity, for every allowed state — no more truthy-gated shortcuts. `terminate`'s stop path re-shows
  the unit immediately before `systemd.stop` and requires `sameSnapshot(live, second) && isExactSnapshotFor(...)`.
  `containmentEmptyProof` now takes two full observations (`first`/`second`) around the cgroup read and requires
  `sameSnapshot` agreement. I traced both functions fully and did not find a remaining same-name-reuse or blank-
  field composition (see R3-H5 below).
- **R2-H3** (CAS insufficient for stale OS-state snapshots): `confirmLaunch` now does S1 (poll) → `readProcs` →
  **S2** (fresh `systemd.show`) → `sameSnapshot(snap, second)` check → CAS. This closes the specific race I
  reported.

## New findings (R3-H1, R3-H2, R3-H3): each is a real over-correction that breaks a legitimate case

### R3-H1 — CONFIRMED (MEDIUM): `terminate()` cannot recognize "unit inactive/failed, cgroup fully removed" as success

`terminate()`'s poll (`linuxProcessFence.ts:492-508`) only reaches the terminal-success return inside
`if (events !== "missing" && events.populated === 0)` — i.e. the cgroup must still **exist** and read
`populated=0`. If the cgroup path itself is already gone (`events === "missing"`) while the unit is genuinely
`inactive`/`failed` (not `not-found`) — a legitimate, plausible outcome once systemd has fully torn the scope down
but not yet garbage-collected the unit object — this branch is never entered, and the loop returns `null` forever
until the wait budget expires.

**Empirically verified**, not just traced: I added a temporary scratch test (removed before finishing this review;
`git status` confirmed clean afterward) that overrides `cgroup.writeKill`/`readEvents`/`readProcs` to model exactly
this state (unit stays `loadState: "loaded"`, `activeState: "inactive"`, cgroup reads `"missing"`) and called
`terminate()`:

```
ProcessFenceError: PROCESS_FENCE_TIMEOUT: cgroup kill did not reach populated=0 with exact unit absence
```

Confirmed reproducible. Note `stableTerminalEmpty`'s own internal logic (`linuxProcessFence.ts:772-778`) already
correctly treats `events === "missing"` as acceptable for **both** its `"not-found"` and `"terminal"` call shapes —
the bug is specifically that the `"terminal"` call site is gated behind a condition that excludes exactly the case
`stableTerminalEmpty` was written to handle. Fails safe (timeout, not a false success), but likely makes real
terminate calls unreliable whenever this ordering occurs.

### R3-H2 — CONFIRMED (MEDIUM): parser rejects a legitimate `fd=0`

`isSafePositive(value) { return Number.isSafeInteger(value) && value > 0; }` (`linuxProcessFence.ts:844-846`) is
applied uniformly to `pid`, `starttime`, and `fd` in both the match-line and unknown-line regex handlers
(`linuxProcessFence.ts:282`, `291`). `pid`/`starttime` are correctly always positive. `fd` is not — I re-checked
the real C helper source (`.tachyon/studies/368-process-audit-helper.c`): `int fd; /* only for KIND_FD; else -1 */`,
and fd numbers are scanned from `0` (`for (unsigned fdn = 0; fdn < fdsize; fdn++)`), so `fd=0` (stdin) is a
genuinely reachable, legitimate value the helper can and does print. Any real audit result that happens to bind
through fd 0 is rejected as malformed by this parser. Fails safe (`unknown`, never a false result), but silently
discards a real, valid finding.

### R3-H3 — CONFIRMED (HIGH for reliability): `confirmLaunch` throws instead of retrying on the completely normal startup window where InvocationID/ControlGroup are not yet populated

`confirmLaunch`'s poll (`linuxProcessFence.ts:440-446`):

```
if (!this.isActiveDeterministicSnapshot(unitName, s)) throw new ProcessFenceError(..., "unit identity is not exact active receipt");
if (!s.invocationId.trim() || !s.controlGroup.trim()) return null;
```

`isActiveDeterministicSnapshot` (`linuxProcessFence.ts:762-765`) **already requires** `snap.invocationId.trim()`
and `snap.controlGroup.trim()` internally as part of its own definition. So the moment a freshly-started unit is
`activeState === "active"` but hasn't yet had systemd populate `InvocationID`/`ControlGroup` — an entirely normal,
expected, brief window in a real `systemd-run --scope` launch — `isActiveDeterministicSnapshot` returns `false`,
and the outer `throw` fires immediately. The second line (`return null` to let `pollUntil` retry) is unreachable
dead code: nothing can ever reach it, because anything that would make it fire (blank InvocationID/ControlGroup)
already made the line above it throw first. This is the same class of composition mistake as R1's original dead
branch (a stricter shared validator reused in a context that actually needs a *lenient* "not ready yet, keep
polling" signal) — but this time on the **primary happy path**, not an edge case. I did not find an existing test
covering "unit active, fields blank on the first poll iteration" — the existing repair/collision tests all seed
`putUnit` with `invocationId`/`controlGroup` already populated from the start, so this regression would not have
been caught by the suite as constructed.

## R3-H4 — CONFIRMED (HIGH, test-truthfulness): the ten new tests still do not exercise several of their own titles' claims

Exactly 10 new tests (`git diff` confirms), matching the diff you flagged. I read each one against its title:

- **"...so create has exactly one winner"**: two `prepareLaunch` calls, fully `await`ed in **sequence** — proves
  idempotent-refusal-on-replay, not concurrent-race resolution. No `Promise.all`, no interleaving.
- **"...corrupt durable receipts..."**: mutates only `schemaVersion` (to `99`). Does not independently test a
  corrupted `nonceDigest`, `unitName`, `phase`, or helper-pin field, despite the title's plural "receipts" framing.
  (The same test's second half **does** genuinely force `compareAndSet` to return `false` — that part is real.)
- **"...or create-losing live unit"**: the test's two scenarios cover empty-procs and wrong-`id`/populated-cgroup —
  neither overrides `store.create` to return `false`. The specific "create-losing" claim in the title has no
  corresponding assertion anywhere in the test body.

I did not exhaustively re-verify every one of the ten against the full R3 contract's blocking matrix (concurrent
create, S1→S2 replacement forced via injected mid-poll mutation rather than pre-seeded state, full helper pin/mode/
owner/cap/nosuid table, parser target/uid/stderr/exit/duplicate/fd0 table) given the size of that ask, but the
three samples above — each independently checked against its own title — confirm the pattern continues from R2:
titles describe a broader property than the assertions underneath them prove. Notably, **no test exercises the
exact scenario in R3-H1** (loaded+inactive+cgroup-missing), which is exactly the kind of gap a real forcing matrix
exists to catch before a reviewer has to find it by hand.

## R3-H5 — no further composition found beyond H1/H2/H3

I read `terminate`'s stop path and `containmentEmptyProof`'s two-observation logic in full, specifically hunting for
any remaining false-empty or foreign-unit-action path beyond the three regressions above. Both now correctly use
`isExactSnapshotFor`, which closes the truthy-gating and missing-`id`-check holes from R2. I did not find a new
composition. The one residual that remains **by design and already disclosed** upstream (not new to this adapter):
a coordinated move-then-restore of the exact same identity values, timed entirely between the two observation
points, is the same class of irreducible same-UID residual the C-helper chain (R1-R5 of that review) already
ratified as out of scope for this threat model — not a new gap this candidate introduces.

## R3-H6 — RESOLVED/REFUTED: `tryRepairPending` does not need its own S1/procs/S2; the caller's re-verification is sufficient

`tryRepairPending` (`linuxProcessFence.ts:698-728`) takes only one `systemd.show()` snapshot before its own
`readProcs` and `store.create()`. But I traced what happens to its return value: `confirmLaunch` never trusts a
repaired identity's fields directly — after repair returns (always `phase: "pending"`), execution falls through to
the **same** `pollUntil` → `readProcs` → S2 → CAS sequence used for the non-repair path, starting from a fresh
`systemd.show()` call, not reusing anything from `tryRepairPending`. Any staleness in the repair path's single
snapshot is independently re-observed and re-verified by `confirmLaunch`'s own subsequent logic. Your hedge
("likely safe") is correct — confirmed, not just assumed.

## R3-H7 — CONFIRMED (LOW/MEDIUM): the unknown-line regex doesn't enforce the `fd=` ↔ `kind=fd` dependency the match-line regex does

The match-line regex (`linuxProcessFence.ts:277`) correctly encodes the C grammar's dependency via alternation —
`kind=cwd`/`kind=root` cannot carry `fd=`, `kind=fd` must. The unknown-line regex
(`linuxProcessFence.ts:287`, `/^unknown reason=[A-Za-z0-9_-]+(?: pid=(\d+))?(?: kind=(cwd|root|fd))?(?: fd=(\d+))?$/`)
has three **independent** optional groups — nothing prevents `unknown reason=eaccess kind=cwd fd=5` (a combination
the real C helper's `add_unknown()` never produces, since `has_fd` is only true for `KIND_FD`) from matching. Low
practical severity (only reachable via malformed/corrupted helper output, and still fails toward rejection in most
surrounding contexts), but a real, confirmed asymmetry between the two line-grammars worth closing for
completeness, especially since R3-H2 already shows this exact code path handles `fd` values incorrectly once.

## Verdict

**FINDINGS.** The correction closes R2's two most severe gaps for real — I verified `terminate` and
`containmentEmptyProof` now share a properly rigorous exact-snapshot validator with no remaining truthy-gating or
missing-id holes I could find. But it introduces three new regressions (R3-H1/H2/H3), each an over-correction that
turns a *legitimate* outcome into an error rather than tightening only the *illegitimate* ones — R3-H3 in
particular sits on the primary confirm happy-path and could make real launches unreliable, not just an edge case.
R3-H4 shows the test-truthfulness gap from R2 persists: titles claiming concurrent/forced/comprehensive coverage
that the assertions underneath don't actually provide, and — tellingly — no test caught any of R3-H1/H2/H3 before
this review did. Recommend a further correction: (1) let `stableTerminalEmpty`'s already-correct "terminal" handling
be reached when `events === "missing"`, not gated out before it; (2) use a nonnegative check for `fd`, not
`isSafePositive`; (3) split `isActiveDeterministicSnapshot`'s "is this receipt-worthy" concern from a genuinely
lenient "should we keep polling" signal so blank InvocationID/ControlGroup on an active unit retries instead of
throwing; (4) add the specific forcing tests named above (loaded+inactive+cgroup-missing terminate,
fd=0 in both match/unknown lines, active-but-blank-fields confirm retry, and a genuinely concurrent create race)
before the next round.
