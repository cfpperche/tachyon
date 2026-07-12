# SDD 368 T14.6A Linux ProcessFence adapter — Sonnet R4 (FINAL) independent review — FINDINGS

Reviewed candidate `d3fae18b` (branch `tachyon/linuxProcessFenceGrokR1`) against journal contract
`j-20989d3fb030` and my R1-R3 reports (`.tachyon/reviews/368-linux-process-fence-t146a-r{1,2,3}.md`). Read the full
`686566eb..d3fae18b` diff (25 production lines, 145 test lines) and the current complete adapter. Canonical
`verify_task` ACCEPT, no waiver, no full — again correctly withheld pending this review. This round targets exactly
R3-H1/H2/H3/H7 plus one new LOW hypothesis, with an explicit instruction that only safety/false-empty/foreign-
action/primary-path-correctness issues should block final closure. **One of R3-H7's two sub-fixes was closed
correctly; the other introduces a new, empirically-confirmed primary-path parsing regression, which I'm treating as
blocking per that same instruction — everything else in this round is a genuine, verified closure.**

## R3-H1 — CONFIRMED CLOSED correctly

`terminate`'s gate is now `if (events === "missing" || events.populated === 0)` (was `events !== "missing" && ...`).
Inside, the terminal-success branch (`stableTerminalEmpty(identity, live, "terminal")`) fires for **both**
`events === "missing"` and `events.populated === 0` whenever `live.activeState` is `inactive`/`failed`. The
`events === "missing"` case with the unit still `active` correctly does **not** proceed toward `stop()` — it
`return`s `null` to keep polling — so the fix closes the false-timeout without opening a new path to `stop()` on an
ambiguous cgroup-missing-but-active state. A dedicated new test ("accepts a stable exact terminal unit after its
cgroup is removed, but never stops an active missing cgroup") covers exactly this shape.

## R3-H2 — CONFIRMED CLOSED correctly

`fd` now validated via a new `isSafeNonnegative` (`>= 0`) in both match- and unknown-line handling, while `pid`/
`starttime` correctly remain `isSafePositive`. Matches the real C grammar exactly.

## R3-H3 — CONFIRMED CLOSED correctly, matches the contract's wording precisely

`confirmLaunch`'s poll now: `not-found`/`activating` → retry; wrong `id` or `inactive`/`failed` → immediate hard
throw; anything else with blank `invocationId`/`controlGroup` → retry; only a fully-populated exact active snapshot
succeeds. This is exactly "not-found, activating, or exact named active snapshot with blank InvocationID/
ControlGroup means not-ready and retries boundedly; wrong id or inactive/failed is a hard refusal" from the R4
contract, verified line-for-line against the diff.

## R3-H7 — PARTIALLY closed; **the other half introduces a new, empirically-confirmed regression**

The "no `fd=` without `kind=fd`" and "`cwd`/`root` never carry `fd=`" dependencies are now correctly encoded. But
the fix also added: `kind === "fd" && (pid === undefined || fd === undefined)` → reject. **This is wrong**: the
real C helper (`.tachyon/studies/368-process-audit-helper.c`) emits `kind=fd` **without** an `fd=` value whenever
the failure is at the whole-fd-directory or whole-process level rather than a specific descriptor —
`add_unknown(a, pid, "fd_dir_error"/"pidfd_open_eperm"/"pidfd_open_enosys"/"pidfd_open_emfile"/"pidfd_open_error"/
"pidfd_fdsize_changed"/"pidfd_scan_disagreement"/"pidfd_deadline"/"pidfd_oom"/<FDSize-read-failure reason>, true,
KIND_FD, false, -1)` — I count **eleven** distinct call sites producing exactly this shape. This is not a
theoretical corner case: `unknown reason=pidfd_nr_open_too_large pid=1533 kind=fd` (no `fd=`) is a line I **directly
observed empirically, myself, in this same review chain**, auditing the R4 candidate of the audit helper against
the real `(sd-pam)` process on this exact host — the precise motivating scenario the entire multi-round audit-
helper effort (five rounds) plus this adapter (four rounds) exists to handle.

**I reproduced the break directly against this candidate.** Added a temporary scratch test (removed before
finishing; `git status` confirmed clean afterward) feeding `parseAuditHelperStdout` a stdout string containing
exactly that already-observed line:

```
RESULT: null
```

`proveEmpty` would report `"audit helper output malformed or incomplete"` instead of any real state determination,
specifically for the class of process (locked/non-dumpable, `fd/` directory DAC-blocked) this adapter's audit
helper dependency was built across five review rounds to handle via the `pidfd_getfd`/`FDSize` fallback. I'm
treating this as **primary-path correctness** per this round's own blocking criteria — it doesn't create a false
`proven_empty` (fails safe to `unknown`), but it breaks real, already-demonstrated, non-edge-case output for the
adapter's core purpose.

## Nine new tests — genuinely improved rigor this round (a real fix to the R3-H4 pattern)

Spot-checked the three specific properties named in this round's contract:

- **Concurrent create race**: `"forces a concurrent prepare create race..."` now uses a real barrier
  (`arrived === 2` releases both waiters simultaneously before either proceeds to the underlying `create`) and
  `Promise.allSettled` on two truly-parallel `prepareLaunch` calls, asserting exactly one fulfilled/one rejected/one
  stored record. This is a genuine fix to R3-H4's "sequential, not concurrent" critique.
- **Repair create loss**: `"forces repair create loss and leaves no receipt"` directly overrides
  `h.store.create = async () => false`, forcing the exact scenario R3-H4 said was never forced, and asserts no
  receipt persists.
- **Stop-boundary same-name drift**: `"never stops after same-name identity drift between empty observation and
  stop"` injects a call-counted `systemd.show` override that mutates `invocationId` on exactly the third call
  (landing between the empty-cgroup observation and the pre-stop re-show), and asserts `stopCalls === 0`. A real,
  targeted regression test for the exact safety property R2-H1 originally flagged.

I did not exhaustively re-verify all nine against every named row of this round's matrix, but these three — the
ones this round's contract specifically called out by name — are honest, forcing, and match their titles. This is
a real, substantive improvement over R2/R3's pattern, not another superficial pass.

## LOW hypothesis — activating+wrong-id polls to timeout instead of immediate refusal: ACCEPTABLE, non-blocking

Confirmed the mechanism: `if (s.loadState === "not-found" || s.activeState === "activating") return null;` fires
before the `s.id !== unitName` check, so a **different, wrong** unit caught in the `"activating"` state on a given
poll iteration is not immediately refused — the poll just keeps waiting (assuming it's our own unit still starting)
until either that wrong unit's state changes (at which point the `id` check does fire and throws immediately) or
the wait budget expires (a generic timeout error). I traced every consequence: no destructive action is ever taken
on the foreign unit in either outcome, no confirm ever succeeds against it, and the only user-visible difference is
diagnostic quality (a slower, less specific timeout vs. a fast, precise "wrong identity" error) for a narrow
composition (a same-named foreign unit that happens to be caught specifically mid-`"activating"`). This is squarely
a diagnostic-quality question, not a safety, false-empty, foreign-action, or primary-path-correctness one — your own
framing is correct. **Non-blocking**, worth a follow-up note only.

## Scope discipline

I did not re-open or extend into the already-ratified malicious same-UID move/restore residual (the C-helper
chain's disclosed, accepted limitation) — nothing in this round's diff touches that boundary, and none of my
findings above depend on relitigating it.

## Verdict

**FINDINGS — one blocking regression, everything else in this round genuinely closed.** R3-H1, R3-H2, R3-H3, and
half of R3-H7 are correctly and verifiably closed; the nine new tests represent a real improvement in forcing
rigor, not another cosmetic pass; the LOW hypothesis is correctly non-blocking. But the other half of R3-H7's fix —
requiring `fd=` whenever `kind=fd` appears in an unknown line — is incorrect against the real C grammar and breaks
parsing for output I have personally, empirically observed on this exact host for the exact process class this
whole effort targets. Recommend a narrow follow-up: drop the `pid === undefined || fd === undefined` half of the
new `kind === "fd"` constraint (keep requiring `fd=` implies `kind=fd`, and `cwd`/`root` never carry `fd=`; do not
require the reverse), with a test asserting `kind=fd` without `fd=` (e.g. `pidfd_nr_open_too_large`) parses
successfully. Everything else in this candidate is ready.
