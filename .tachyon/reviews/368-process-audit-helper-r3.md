# SDD 368 CAP_SYS_PTRACE process-audit helper — Sonnet R3 independent security review — ACCEPT

Reviewed correction candidate `f4cb690934e4f02b7cdc957cb4553da0e663318d` (branch
`tachyon/processAuditHelperGrokR1`, worktree `/home/goat/.cache/tachyon/worktrees/b349073a/processAuditHelperGrokR1`)
against journal contract `j-43d7882cee5b`, my own R2 report (`.tachyon/reviews/368-process-audit-helper-r2.md`,
`c450e11e`, H1/H2), and the closed correction contract `j-df883330e9cf`. Read the full corrected C source (881
lines, +138 vs R2), the full generated test (428 lines, +177), and the full updated report (349 lines) line by
line. Canonical `verify_task` ACCEPT, no waiver, including `npm run verify:full:quiet` (307 files, 3676 pass).

## H1 — CONFIRMED closed: compile-time `TEST_ONLY` seam, mandatory barrier, no race-miss fallback

`test_seam_barrier()` and its call sites are entirely wrapped in `#ifdef TEST_ONLY` (`368-process-audit-helper.c:
414-452`); outside `-DTEST_ONLY`, `TEST_SEAM(phase)` expands to `((void)0)` and the function itself isn't compiled
in at all. Barriers fire at `TEST_SEAM("post_pin")` in `main()` immediately after the first successful
`revalidate_target()` (line 862) and at `TEST_SEAM("obs")` once per run inside `consider_link()` at the first
per-link observation (lines 474-484), each followed by an explicit re-`revalidate_target()` so a rename held across
the barrier is observed before continuing. The wait is bounded (~30s, `usleep(1000)` × 30000) — not an unbounded
hang risk.

**Independently reproduced, without touching vitest at all.** I compiled both variants myself with the exact
claimed flags:

- Source SHA-256 `f0172691...` — exact match.
- Hardened (no `-DTEST_ONLY`) binary SHA-256 `a7a756d7...` — exact match to the report's pinned hash.
- `strings` on my own hardened build: **zero** occurrences of `PAH_TEST_SEAM_DIR`, `PAH_TEST_SEAM_PHASE`,
  `%s/%s.ready`, `%s/%s.release`, or `post_pin` — the seam is genuinely absent from the checksum-pinned binary, not
  just source-gated. `getcap` on it shows no capabilities (as expected, no setcap performed).
- `strings` on my own `-DTEST_ONLY` build: all of those strings present, confirming the seam only exists in the
  explicitly-separate, never-proposed-for-capability build.
- I wrote a standalone Python driver (no vitest, no reuse of the candidate's own test harness) that sets
  `PAH_TEST_SEAM_DIR`/`PAH_TEST_SEAM_PHASE`, waits for the `<phase>.ready` marker, performs a real
  `rename(target, moved); mkdir(target)` replacement, then releases. Ran `post_pin` and `obs` phases **3 times
  each** (6 runs total): **6/6** produced `state=unknown` with `unknown reason=target_identity_drift` — fully
  deterministic, no ambient-EACCES-only outcome, no race-miss fallback possible (the barrier wait itself would
  time out and fail loudly if the marker were never reached).
- Ran the candidate's actual generated test via `npm test` three times: consistently ~500-900ms, always passing,
  never hanging.

This closes H1 exactly as required: the proof no longer depends on winning an uncontrolled OS-scheduling race (the
gap I demonstrated in R2), and the seam cannot leak into the binary that would ever be proposed for `setcap`.

## H2 (practical) — CONFIRMED closed: per-observation pre/post revalidation on every exit path

`consider_link()` now: (1) short-circuits immediately if `a->target_failed` is already sticky-set; (2) revalidates
and captures the pin's **live** `/proc/self/fd` path *before* reading the specific process's link; (3) reads the
link; (4) revalidates *again* on **every** exit branch. I traced all seven `switch(rr)` cases plus the
non-path-pseudo-target case plus the final match/no-match fall-through — each one calls `revalidate_target()`
again before returning. `scan_one_pid` additionally checks `a->target_failed` after `cwd`, after `root`, inside the
per-fd loop (`if (a->target_failed) break;`), and after the fd loop, so a drift detected mid-scan halts everything
immediately rather than continuing to accumulate stale evidence. `run_audit`'s per-PID loop and post-loop both also
check `target_failed` and return `ST_UNKNOWN` immediately. `target_failed` is set exactly once, inside
`add_unknown_critical` (the same function every `revalidate_target` failure path already funnels through), so
sticky behavior is centralized in one place, not duplicated/riskable-to-drift across call sites.

Independently confirmed via the same standalone driver: `obs` phase + full rename/replace → deterministic
`target_identity_drift`, 3/3 runs.

**Self-pin exclusion**: `scan_one_pid` explicitly skips `pid == self_pid && fdn == a->target_fd`
(`368-process-audit-helper.c:609-611`) — confirmed unchanged from R2, still correct.

**Critical reason survives truncation**: `add_unknown_critical` still clobbers the last report slot rather than
dropping when the 64-entry buffer is full; unchanged from R2 and re-confirmed applicable here since the mechanism
is identical.

## H2 (fundamental) — the swap/restore residual is honestly characterized, not claimed closed

The report is explicit and consistent: a new "Irreducible residual" section states a same-UID actor coordinating
"move+restore entirely between separate procfs syscalls... cannot be mathematically excluded," the findings table
marks H2 as "**Practical fail-closed**... **fundamental residual remains**... production still **BLOCKED**" (not
"Closed"), and "What this does not authorize" explicitly lists "erase the irreducible multi-syscall move+restore
residual." The generated test's third drift block (`obs` phase + `rename(target,moved); rename(moved,target)`
before release) deliberately does **not** assert a specific `target_*` reason — its own comment says so ("helper
may complete without target_*... fail-closed incompleteness — not a proven_empty claim").

**I independently verified this characterization is accurate, not just asserted.** Using my standalone driver with
a third mode (`swap_restore`: rename away then immediately rename back, same inode, before releasing the barrier),
run against the `obs` phase: `state=unknown`, but **no** `target_*` reason line — exactly matching the report's
own claim, confirming it is neither over- nor under-stating what the mechanism actually catches. On this host the
result still lands on `unknown` only because of ambient same-UID `EACCES` noise (systemd/sd-pam/postgrest), not
because the swap/restore was detected — which is precisely the residual being disclosed: under a hypothetical
fully-readable environment (e.g. with `CAP_SYS_PTRACE` and no other EACCES sources), this exact sequence could
reach `empty`/`survivors` without ever registering the transient window. The report does not overclaim here.

## Minor, non-blocking observation: a pre-existing (not new to R3) test cleanup gap

Running the generated test fresh from a clean `/tmp` leaves one dangling symlink behind
(`tachyon-368-audit-real-*-link`). Root cause: `scratch` pushes `realDir` before `linkPath`, so by the time
`finally`'s cleanup loop reaches `linkPath`, `realDir` is already gone and `linkPath` is a dangling symlink; I
confirmed directly in Node that `fs.rmSync(danglingSymlink, {recursive:true, force:true})` silently no-ops instead
of unlinking it (a Node `fs` quirk, not a bug in the C helper). This exact `scratch.push` ordering is unchanged
from the R1/R2 test versions, so it is not a regression introduced by this candidate — flagging only for hygiene;
it has no security or correctness implication (empty dangling symlink, no data), and is outside the scope of what
this review round was asked to confirm.

`git diff --check 3d5ea402..f4cb6909` reports two trailing-whitespace lines in the `.md` report, both intentional
Markdown hard-linebreak two-space suffixes (consistent with the convention used throughout every prior study
document in this SDD) — not a defect.

## Verdict

**ACCEPT.** H1 is closed correctly and verifiably: the synchronization seam is compile-time absent from the
checksum-pinned hardened binary (confirmed via my own independent build + `strings`, not just trusting the
candidate's self-check), the barrier is mandatory with a bounded wait (no hang risk), and I independently
reproduced deterministic, specific `target_identity_drift` detection outside the candidate's own test harness, 6/6
across both phases. H2 is closed at the practical level the correction contract asked for — per-observation
pre/post revalidation on every code path, verified by code trace and independent reproduction — while the
fundamental multi-syscall residual is honestly disclosed, not claimed away, and I independently confirmed the
report's own characterization of what does and does not get caught is accurate. Production `proven_empty` /
default adapter rollout correctly remains `BLOCKED`; no setcap was performed by this candidate or by me. No
concrete HIGH/MEDIUM defect or report/test dishonesty found in this correction.
