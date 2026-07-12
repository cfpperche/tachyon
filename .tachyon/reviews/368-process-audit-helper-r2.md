# SDD 368 CAP_SYS_PTRACE process-audit helper — Sonnet R2 independent security review — FINDINGS

Reviewed correction candidate `3d5ea402897bc2f6f0da6d65793cfbc40170694e` (branch
`tachyon/processAuditHelperGrokR1`, worktree `/home/goat/.cache/tachyon/worktrees/b349073a/processAuditHelperGrokR1`)
against journal contract `j-a4dada7ca404`, my own R1 report (`.tachyon/reviews/368-process-audit-helper-r1.md`,
`fe72ca16`, F1 MEDIUM/F2 LOW-MEDIUM), and the closed correction contract `j-2cf388e6c4cf`. Read the full corrected C
source (743 lines, +190 vs R1) and the full generated adversarial test (251 lines, +249) line by line. Canonical
`verify_task` ACCEPT, no waiver, including a first-reviewable `npm run verify:full:quiet` (307 files, 3676 pass).

## F1/F2 closure — CONFIRMED closed

**F1** (target canonicality / TOCTOU): `main()` now calls `realpath(target, resolved)` and requires
`strcmp(resolved, target) == 0` — a symlinked or non-canonical input is refused (`target_not_canonical`) before any
scan. It then opens `O_PATH|O_DIRECTORY|O_CLOEXEC`, `fstat`s to pin `st_dev`/`st_ino`, and `revalidate_target()`
(`368-process-audit-helper.c:200-259`) is called once before the first pass and then at both the **start and end**
of every fixed-point iteration (`run_audit`, lines 557-589): re-`realpath` byte-exact, re-`stat` the path, `fstat`
the pinned `O_PATH` fd, and `readlink("/proc/self/fd/<fd>")` checked for a `" (deleted)"` suffix and byte-exact
match — any mismatch fails to `unknown` via `add_unknown_critical`, never silently to `empty`/`survivors`. I
independently compiled the exact corrected source (`sha256sum` matches the report's claimed
`28c7568f...` exactly) and the resulting binary hash also matches exactly (`a2228ac9...`).

**F2** (sticky capability-loss transparency): `run_audit`'s per-pass reset no longer only *detects* loss once —
`if (a->saw_cap_loss) add_unknown(a, 0, "capability_loss", ...)` now runs unconditionally at the top of **every**
pass once the sticky flag is set, so the reason is re-emitted into every pass's freshly-reset report, including the
final stable one. A final `state=unknown` can no longer print `unknown_count=0` with no reason line from an
earlier-pass-only loss. Confirmed by code reading (an empirical live-capability test is outside this review's
authorized, no-setcap scope, as before).

Both closures are correctly scoped: `add_unknown_critical` doesn't touch the ordinary `add_unknown` truncation
behavior, and I empirically confirmed (below) that a critical `target_*` reason survives even when the ordinary
EACCES unknown list is truncated at its 64-entry cap.

## H1 — generated rename/replacement test is not proven deterministic (CONFIRMED as a real design gap, though not observed misfiring in this candidate's actual runs)

The new adversarial case (`test/unit/processAuditHelperGrokR1Behavior.gen.test.ts:174-224`) races a Python attacker
against the helper: the attacker polls `/proc` for the helper's PID via `cmdline` matching, then
`rename(target, moved); mkdir(target)`. The assertion is conditional on whether the attack flag file exists:

```js
if (attacked) {
  expect(drifted.stdout).toMatch(/unknown reason=target_(identity_drift|deleted|path_drift|missing)/);
} else {
  // Race miss still must fail closed (host EACCES incompleteness).
  expect(drifted.stdout).toMatch(/unknown reason=/);
}
```

This is exactly the shape the coordinator's hypothesis names: the `else` branch's assertion is trivially satisfied
by the ambient `eaccess` unknowns from `systemd`/`(sd-pam)`/`postgrest` that are present on **every** invocation on
this host regardless of whether the rename attack landed at all, let alone landed in the specific window (after the
helper's initial pin, during the scan) that would actually exercise `revalidate_target()`'s drift detection.

**I built a standalone reproduction of the identical race mechanics** (same attacker script, same 50 decoy
processes, same polling strategy) outside vitest, using Python's `subprocess.Popen`/`subprocess.run` in place of
Node's `child_process.spawn`/`spawnSync`. Across 12 trials, the attack landed (`attacked=true`) in **all 12**, but
the specific `target_*` reason appeared in **0 of 12** — full stdout in every case showed only the ambient
`eaccess` unknowns. Root cause: in that reproduction, the attacker's `/proc` scan found and struck the helper *so*
early that the rename completed **before the helper's very first `open()`/`realpath()` pin in `main()`** — the
helper then pins the *already-replaced* directory as its baseline and correctly finds no further drift, because
there is no "before" state left to compare against. This demonstrates the failure mode `if(attacked){...}` is
supposed to catch is not just theoretical — a plausible variant of the exact same race construction reliably
produces it.

**I then instrumented an exact copy of the real candidate test** (added a diagnostic `console.error` logging
`attacked` and full stdout; ran it, then deleted the scratch file — worktree left clean, confirmed via `git
status`) and ran it four times through the actual `npm test`/vitest/Node spawn path. All four times, `attacked` was
`true` **and** the specific `target_identity_drift` reason was present — including one capture where it correctly
survived alongside `unknown_truncated=yes omitted=103`. So on this host, with Node's actual process-spawn timing,
the real embedded test has consistently landed in the intended detection window across my sampling — my standalone
Python-based reproduction of the "too-early" failure apparently doesn't share Node's exact scheduling latency.

**Conclusion:** this is a real, unresolved test-design gap, not a false alarm — the proof is contingent on an
uncontrolled OS-scheduling race with no explicit synchronization, its `else` branch provides zero verification of
anything TOCTOU-specific, and I demonstrated concretely (via a variant construction) that the race *can* resolve
the "wrong" way and defeat the intended assertion. That it happened not to in my direct sampling of the actual
embedded test doesn't make the proof deterministic — a different host, CI runner load, kernel scheduler, or even
just unlucky timing could still land in the `else` branch and silently skip verifying the rename-detection logic
entirely, with a normal CI observer seeing only a green checkmark. **A controlled synchronization seam is still
warranted** — e.g., a build-time test-only hook that pauses the helper immediately after its initial pin (signaled
via a FIFO/marker file) so the attacker's rename is guaranteed to land in the scan window, removing the race
entirely, or at minimum asserting `attacked === true` outright (so the else-branch scenario fails the test loudly
instead of silently passing).

## H2 — pre/post-pass-only revalidation does not close a per-process swap-then-restore window (CONFIRMED, NOT closed by this candidate)

`revalidate_target()` runs only twice per fixed-point pass: once before `collect_pids()`/the scan loop, once after.
`path_binds()` (`368-process-audit-helper.c:265-279`) is a pure string comparison between `a->target` and whatever
each individual process's `readlink(/proc/<pid>/{cwd,root,fd/n})` returns *at the moment that specific process is
scanned* — it does not re-check the target's identity at that instant.

Consider: an attacker with the same PID-detection technique demonstrated above times a `rename(target, moved)` to
land immediately before the scan loop reaches a **specific** bound process's turn, so that process's `cwd` now
reads as `moved` (Linux's `/proc/<pid>/cwd` reflects the dentry's *current* path, so a bound process's apparent cwd
changes the instant the directory is renamed — `path_binds()` against the original `target` string then misses
it), then `rename(moved, target)` restores the *same inode* back to `target` before the pass-end
`revalidate_target()` runs. Because it is literally the same directory moved out and back, `st_dev`/`st_ino` at
pass-end are unchanged from the pass-start pin — `revalidate_target()` correctly reports no drift, while the one
process that was genuinely bound was never observed matching the target string during its individual scan window.
No `any_vanished` is triggered (the process never disappeared), so there is no fixed-point rescan to catch it on a
later pass either. The result is a genuine **silent under-report** — exactly the failure class the whole
independent-audit clause exists to prevent — that pre/post-*pass* boundary checking cannot see, because the attack
is scoped to a window *inside* a single pass, correlated with one specific process's scan moment rather than the
pass as a whole.

This gap is not mentioned in the report's revised security analysis or "not proved" table (I grepped for
`swap|restore|per-link|mid-scan|between pass` — no hits describing this specific scenario; the report's F1 closure
claim and "mid-scan rename/replacement reports target_* unknown (fail-closed)" line both describe the *coarser*
pass-boundary case this candidate does correctly handle, not the finer per-process race). Closing it fully likely
needs either: (a) revalidating the target's pinned identity immediately around *each* individual bound-process
observation rather than once per pass (expensive, and still has a — much narrower — residual race), or (b) a
different verification primitive that doesn't rely on target-identity-at-rest at all, e.g. correlating what each
process's link resolved to at the exact moment of observation against a live target reference rather than a static
string, or (c) an explicit, disclosed acceptance that this residual window remains and is bounded only
probabilistically by pass speed. I'm not the one to pick that design — flagging it as the concrete threat-model gap
H2 asked me to characterize.

## Remaining scrutiny points — reconfirmed, no new issues

- **Self target-FD exclusion**: `scan_one_pid` explicitly skips `pid == self_pid && fdn == a->target_fd`
  (`368-process-audit-helper.c:486-488`) so the helper's own `O_PATH` pin never counts as a match against itself —
  confirmed by code and by every empirical run above showing `match_count=0` on a target with no external binder.
- **Critical unknown reporting under truncation**: empirically confirmed — a capture with `unknown_count=167` and
  `unknown_truncated=yes omitted=103` still printed `unknown reason=target_identity_drift` intact.
- **Hashes/report honesty**: source and binary SHA-256 in the report match my independent build exactly; verdict
  remains honestly `BLOCKED`, still states "No setcap was performed in this correction," no `PASS` claim anywhere.
- **Cleanup / no-cap / live-FD**: re-reproduced the no-cap `unknown` fail-closed result (same three ambient EACCES
  PIDs) and live open-FD-match detection from R1; both still hold under the corrected source. Left no processes,
  temp files, or scratch test files behind (`git status` clean in the worktree after every experiment).

## Verdict

**FINDINGS.** F1 and F2 from R1 are correctly and fully closed — confirmed by code audit and independent
reproduction, including hash-level build reproducibility. H1 is a real, demonstrated-reachable (via a faithful
variant) test-determinism gap: the rename/replacement proof is not guaranteed and needs a controlled seam rather
than a bare race, even though I did not catch it misfiring in the actual candidate test across my sampling. H2 is a
genuine, currently undisclosed architectural gap: pre/post-*pass* revalidation does not close a per-process
swap-then-restore window *within* a pass, and a sophisticated attacker using the same PID-detection technique
demonstrated in this review's own H1 reproduction could exploit it for a silent under-report. Neither finding
contradicts the candidate's own honest `BLOCKED`/no-setcap posture; both should be resolved (or explicitly
accepted as documented residual risk) before this prototype is treated as ready for `CAP_SYS_PTRACE` installation.
