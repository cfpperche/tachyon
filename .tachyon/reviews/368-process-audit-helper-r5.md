# SDD 368 CAP_SYS_PTRACE process-audit helper — Sonnet R5 independent security review — ACCEPT

Reviewed candidate `f25308b71a545062c42cecb8194d4b8d00c24246` (branch `tachyon/processAuditHelperGrokR1`) against
journal contract `j-45a03b3b76ed`, the R5 correction contract `j-de678ede82c3` (implementing my own R4
recommendation to bound the `pidfd_getfd` probe by `/proc/<pid>/status` `FDSize` instead of the infeasible global
`fs.nr_open`), and my four prior reports (R1-R4). Read the full 351-line C source diff and 109-line test diff.
Canonical `verify_task` ACCEPT, no waiver, `npm run verify:full:quiet` green (307/3676).

## Strict one-snapshot Uid+FDSize parsing

`read_status_uid_and_fdsize()` opens `/proc/<pid>/status` **once** and parses both `Uid:` and `FDSize:` from the
same `fgets` loop over the same file handle — a genuine single read, not two separate opens that could race against
each other. Parsing is strict on every axis the contract asked for:

- **Missing**: `fdsize_hits == 0` → `pidfd_fdsize_missing` (distinct from malformed).
- **Duplicate**: `fdsize_hits > 1` → `pidfd_fdsize_duplicate`; likewise a duplicate `Uid:` line → `status_unreadable`.
- **Malformed**: leading non-digit, `strtoul` consuming zero characters, or trailing content after the number that
  isn't whitespace/newline → `pidfd_fdsize_malformed`. `> UINT_MAX` is explicitly rejected as malformed (overflow
  guard), not silently truncated.
- **Zero**: accepted by the parser then explicitly checked and rejected as `pidfd_fdsize_zero` — a real process
  cannot have `FDSize=0` (it always owns at least stdin/stdout/stderr slots), so this is correctly a signal of
  something wrong, not a legitimate "no fds" report.
- **Validated against ceilings** in `read_validated_fdsize()`: `FDSize > nr_open` → `pidfd_fdsize_above_nr_open`
  (nr_open now correctly demoted to validation-only, exactly as directed — a value that fails this can only mean
  corruption or a hostile status file); `FDSize > PIDFD_FDSIZE_SAFE_MAX` (1,048,576) → `pidfd_fdsize_too_large`
  (the memory/deadline ceiling, now correctly applied to `FDSize`, not `nr_open`).
- **Identity-bound**: `read_validated_fdsize` also compares the status snapshot's own `Uid` against the caller's
  expected real UID and fails to `identity_drift` on mismatch — defends against a PID-reuse race between the
  earlier same-UID check and this later status read.

## Pre/mid/post stability without a monotonicity assumption

I count **four** checkpoints, not three: (1) the initial validated read before `pidfd_open`, (2) an added re-pin
immediately after `pidfd_open` succeeds (new in R5 — catches drift in the window while acquiring the pidfd itself),
(3) mid-scan between the two probes, (4) post-scan after the second probe. Every checkpoint requires **exact**
equality (`!=`) to the first reading — not "did it grow" or "did it shrink," just "did it change at all" — which
correctly implements "never assume monotonicity." Starttime is checked at the same three of these four checkpoints
(all but the pidfd-open one), continuing the existing PID-reuse defense.

## Two-scan exact evidence agreement — unchanged, correctly re-bounded

`pidfd_probe_once` is unchanged in logic from R4 (`EBADF`=hole, every other errno aborts to a specific reason,
occupied evidence sorted and compared for exact agreement across both scans) — only the loop bound changed from
`nr_open` to the validated `fdsize`. I traced every exit path in `scan_fds_via_pidfd` (7 early returns plus the
success path) and confirmed `occ1`/`occ2` are freed and `pidfd` closed on all of them.

## Independent verification — reproduced everything, not just read the diff

- **Hashes**: my own compile of the exact source produced `sha256sum` → `e60d1cc8...` (source) and `856b0b78...`
  (hardened binary), both exact matches to the report's pinned values.
- **Seam absence**: `strings` on my hardened build shows zero occurrences of any `PAH_TEST_*` variable; the
  `-DTEST_ONLY` build shows all of them.
- **sd-pam behavior changed as expected**: ran my own build against a fresh disposable target with no capability.
  Where R4 reported `pidfd_nr_open_too_large` for PID 1533 (refusing to even attempt a probe), R5 now reports
  `unknown reason=pidfd_getfd_eperm pid=1533 kind=fd fd=0` — meaning `FDSize` validation now correctly **passes**
  (128 ≤ both ceilings) and the fallback genuinely attempts the probe, failing only on the missing capability
  itself. This is concrete confirmation that the FDSize redesign closes the gap I identified in R4, leaving
  capability as the only remaining blocker for this specific process.
- **fd=5000 proof, reproduced independently of the candidate's own test harness**: I wrote a standalone Python
  driver (not vitest, not reusing `runWithSeam`/`runHelper`) that sets `PAH_TEST_FORCE_PIDFD_FD_SCAN=1` and
  `PAH_TEST_SPAWN_HIGH_FD=5000` directly and parses the raw output. Ran it twice: both times, `match ... kind=fd
  fd=5000` is present and `fd=4999` (immediately adjacent, expected to be a hole) is absent — deterministic, not
  a race. (I also observed `fd=3` correctly reported as an *additional*, genuine match in the same run — the
  test child inherits the parent's own `O_PATH` target-pin fd across `fork()`, which is a real second binding to
  the target, not a bug; the self-target-fd exclusion only applies when the *scanning* process's own pid matches,
  not an unrelated child that happens to have inherited a copy.)
- **All three new seams independently triggered**, each with its own disposable target, no test-harness reuse:
  `PAH_TEST_FDSIZE_MALFORMED=1` → `pidfd_fdsize_malformed`; `PAH_TEST_FDSIZE_CHANGE=1` → `pidfd_fdsize_changed`
  (confirms the shrink-testing direction actually fires, not just growth); `PAH_TEST_FDSIZE_TOO_LARGE=1` →
  `pidfd_fdsize_too_large`.
- **Test run**: fresh `/tmp`, ran the actual generated test via `npm test` — passes in ~1.1s, no hang. One
  dangling-symlink cleanup artifact remains, identical to the pre-existing (not new to R5) nit I flagged in R3/R4
  — a Node `fs.rmSync` quirk on an already-removed parent, unrelated to the C helper.
- **`git diff --check`**: only the same benign Markdown hard-linebreak trailing-whitespace line already present in
  every prior round's report — not a defect.

## Report honesty

Explicitly states the report does **not** claim the `sd-pam` residual is closed: "A capped empirical re-run against
`(sd-pam)` is still required before any host-complete claim," names `FDSize=128` as the relevant fact for that
future run, restates the pinned hardened binary hash for that eventual recheck, and keeps the irreducible
swap/restore residual and `BLOCK production proven_empty / adapter rollout` framing unchanged and prominent. No
`CAP_DAC_READ_SEARCH`, no setcap performed. Consistent with every prior round.

## Verdict

**ACCEPT.** The FDSize redesign is implemented correctly and matches the correction contract precisely: strict
single-snapshot parsing with explicit handling for missing/duplicate/malformed/zero/overflow, `nr_open` correctly
demoted to a validation-only ceiling, four-checkpoint stability with no monotonicity assumption (verified in both
directions), and a genuinely deterministic, capability-free proof for `fd=5000` that I independently reproduced
outside the candidate's own test infrastructure. The sd-pam behavior change (`pidfd_nr_open_too_large` →
`pidfd_getfd_eperm`) is exactly the signal that the redesign is working as intended — capability, not the probe
bound, is now the only thing standing between this design and a complete same-UID audit for that class of process.
No concrete HIGH/MEDIUM defect or report/test dishonesty found. Production `proven_empty` / default adapter
rollout correctly remains **BLOCKED** pending both a real capped empirical run and resolution of the disclosed
swap/restore residual — nothing in this round changes that, and the report does not claim otherwise.
