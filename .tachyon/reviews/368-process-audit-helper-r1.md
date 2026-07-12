# SDD 368 CAP_SYS_PTRACE process-audit helper — Sonnet R1 independent security review — FINDINGS

Reviewed immutable candidate `e5a5ca6d6949fe1bd128b5fa5d9e898042f1073d` (branch
`tachyon/processAuditHelperGrokR1`, worktree `/home/goat/.cache/tachyon/worktrees/b349073a/processAuditHelperGrokR1`)
against journal contract `j-e92464a8466c`. Read the full C source
(`.tachyon/studies/368-process-audit-helper.c`, 569 lines) line-by-line and the accompanying report
(`.tachyon/studies/368-process-audit-helper-spike.md`, 289 lines). Confirmed canonical `verify_task` ACCEPT with no
waiver (`.tachyon/verifications/e5a5ca6d6949fe1bd128b5fa5d9e898042f1073d.json`); the "canonical behavior" gate here
is a shallow `grep -Eq Verdict` on the report text, so this review is the real security gate before any
CAP_SYS_PTRACE authorization.

The report's own verdict is **BLOCKED** — it does not claim `PASS`, does not claim capability feasibility was
demonstrated, and explicitly defers `setcap` to one human-run command against a checksum-pinned binary. That
framing is honest and I did not find anything to contradict it. My job here is to independently verify the
prototype's own claims and surface anything relevant to the eventual authorization decision.

## Independent verification performed

- **Source integrity.** `sha256sum .tachyon/studies/368-process-audit-helper.c` → `7184effe...2a5b3`, exact match to
  the claimed source SHA-256.
- **Reproducible, hardened build.** Compiled with the exact claimed flags
  (`-O2 -pipe -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now`),
  zero warnings/errors. Resulting binary SHA-256: `ec388bda...80eba1` — **exact byte-for-byte match** to the
  report's claimed binary hash, on the same host/toolchain (gcc 15.2.0). `readelf` confirms `BIND_NOW` / full RELRO
  and `Type: DYN` (PIE) as claimed.
- **No-cap fail-closed reproduced exactly.** Ran the freshly built (uncapped — confirmed via `getcap`, no
  capabilities) binary against a fresh empty disposable target: `state=unknown`, `exit=2`, `unknown_count=164`, the
  same three `EACCES` PIDs the report cites (`1530 systemd`, `1533 (sd-pam)`, `1193083 postgrest`), and no
  unrelated path strings in the output — only `target=` echoes my own supplied argument.
- **Live open-FD match reproduced exactly.** Spawned a disposable writer (`chdir("/")`, open FD to a target-local
  log file) and re-ran: `match_count=1`, `match pid=<pid> ... kind=fd fd=3`, `state=unknown` (correctly not
  overridden by the match, since unrelated EACCES unknowns are still present) — matches Experiment 2 precisely.
- **Additional adversarial test I designed myself (not in the report): path-prefix boundary.** Created sibling
  directories `.../wt` and `.../wtXXX` (sharing a string prefix but not a real parent/child relationship), put a
  process's cwd in `wtXXX`, and confirmed the helper reports `match_count=0` against target `wt` and `match_count=1`
  (correctly, `kind=cwd`) against target `wtXXX`. `path_binds()` has no naive-prefix false-positive bug.
- **Input validation.** Exercised every rejection path by hand: relative path, `/./`, `/../`, trailing slash, no
  args — all correctly rejected with `exit=3` and the documented error codes; bare `/` is accepted per the code's
  explicit special-case (not something the production caller would ever pass for a worktree, but not a bug either).
- Cleaned up every temp directory and process I created; did not attempt `setcap` (outside this review's
  authorization) and left no capped binary anywhere.

I did not independently exercise a live `CAP_SYS_PTRACE`-effective run — that requires the interactive `sudo
setcap` step this candidate correctly declined to perform itself, and doing so is outside this review's granted
(read-only) scope.

## Findings

### F1 — MEDIUM: the helper trusts the caller's `target` canonicality with only lightweight string checks, not an independent `realpath()`; a stale/symlinked target silently under-reports rather than failing to `unknown`

`main()` (`368-process-audit-helper.c:499-519`) rejects a target that is relative, contains a literal `/./` or
`/../` substring, or has a trailing slash — but never calls `realpath()` (or equivalent) to verify the string the
caller passed is *actually* the fully-resolved canonical path with no symlink components anywhere in it. `readlink`
on `/proc/<pid>/cwd`/`root`/`fd/<n>` always returns the kernel's fully-resolved real path
(`consider_link`/`path_binds`, `368-process-audit-helper.c:291-324`, `168-182`), so `path_binds()` is a pure string
prefix comparison between that resolved kernel path and the caller's `target` string.

If the caller supplies a target that is syntactically canonical-looking (absolute, no `.`/`..`) but whose *value*
is not the real resolved path — e.g. a symlinked worktree mount point, or a TOCTOU window where a path component is
swapped between the caller's own `realpath()` call and this helper's invocation — the string comparison in
`path_binds` will never match a real binding through that stale/symlinked component, and the scan will report
fewer matches than actually exist. Combined with the state precedence (`run_audit`,
`368-process-audit-helper.c:433-488`: `unknown` only from *observed* incomplete evidence, never from an
un-checked-but-wrong target), this specific failure mode does **not** surface as `unknown` — it silently produces
whatever the (incomplete) string-matched result would otherwise be, which for an otherwise-clean host is `empty`
(the exact false-safe result the whole ProcessFence audit exists to prevent).

The report explicitly delegates canonicalization to the caller ("accept one canonical absolute directory target")
and this is a real, disclosed contract — I'm not asserting the prototype breaks its own stated contract. But this
is a security-sensitive helper intended to eventually run with a real privileged capability, gating a real
production safety decision (whether a worktree is safe to reuse). For that use, trusting an unverified string
argument as *the* security boundary, with no independent verification even as defense-in-depth against a caller
bug, is a gap worth closing before this graduates past prototype status: the production port (or this helper
itself) should call `realpath()` on the target and compare the *resolved* value, refusing (fail-closed, not
silently continuing) if resolution fails or if the resolved value differs from what was passed.

### F2 — LOW/MEDIUM (code-reading only, not empirically reproduced — requires a live capability I'm not authorized to install): a capability loss detected in an early fixed-point pass can leave the final printed output with `unknown_count=0` and no listed reason, even though `state=unknown`/`exit=2` correctly still fires

`run_audit` (`368-process-audit-helper.c:433-488`) resets `match_count`/`unknown_count`/`match_report_n`/
`unknown_report_n` at the top of *every* fixed-point iteration, but deliberately does **not** reset
`a->saw_cap_loss` (the code comment even says so: "keep cap_loss sticky across passes"). The final decision
correctly ORs `a->saw_cap_loss` into the `unknown` branch (`if (a->saw_cap_loss || a->unknown_count > 0) return
ST_UNKNOWN;`), so the *state*/exit code stays conservative and correct even if capability is lost only transiently
in an early pass and not observed again in the final, stable pass.

But the printed `unknown reason=capability_loss` line is only emitted in the iteration where the loss is actually
detected (`368-process-audit-helper.c:448-451`), and since the report arrays are reset each pass, that line does
not survive into a later pass's printed output. So a real, narrow sequence is possible: capability lost in pass 1,
capability restored (or the check just doesn't re-trip) by the final stable pass, final pass has zero other
unknowns → operator/consumer sees `state=unknown` `exit=2` `unknown_count=0` with **no** `unknown reason=...` lines
at all, contradicting the report's own stated output contract ("emit only machine-readable state + match ...
+ bounded unknown reasons"). This is not a fail-open bug (the state is still correctly conservative) — it's a
transparency/debuggability gap: a consumer or operator has no way to see *why* the scan was `unknown` in that
specific interleaving. I could not reproduce this empirically without a live effective `CAP_SYS_PTRACE` and a way
to revoke it mid-run, which is outside this review's read-only, no-setcap scope; flagging from code reading only.

## Positively verified, no issue found

- `/proc/<pid>/stat` starttime parsing correctly locates the field 22 boundary via `strrchr(buf, ')')` (last
  `)`, not first), defending against a `comm` containing spaces or parentheses — matches the accepted architecture
  note on this exact class of bug.
- Same-real-UID domain enforcement (`read_real_uid` + `ruid != a->self_ruid` silent skip) matches the accepted T0.2
  design precisely.
- `path_binds` prefix-boundary logic is correct (independently adversarially tested above, no false positive).
- `strip_deleted_suffix` and truncation/malformed-link (`RR_TRUNC`/`RR_MALFORMED`) handling are bounds-checked and
  fail closed to `unknown`, never to a false negative.
- Starttime is read before and after the per-pid link scan and compared for `identity_drift`, correctly defending
  against PID reuse mid-scan.
- Fixed-point rescan is hard-bounded at 8 passes and fails closed (`instability_fixed_point`) on exhaustion — no
  infinite loop.
- `cap_sys_ptrace_effective()` correctly reads the *effective* capability bit via raw `capget`, fails closed to
  "no capability" on any syscall error.
- Output never prints another process's cwd/root/FD path string, only `target=` (the caller's own argument), small
  integers, and reason codes; match/unknown lists are hard-capped with accurate `*_truncated=yes omitted=N`.
- Syscall surface is genuinely read-only: no `ptrace()`, no signal-sending syscall, no procfs writes, no open with
  a write mode anywhere in the source. `<sys/prctl.h>` is included but never actually called — dead include, not a
  security issue, just a hygiene nit.
- The report's characterization of *why* `CAP_SYS_PTRACE` is the right capability (Yama `ptrace_scope=1` blocks
  same-UID, non-child `/proc` link reads unless the reader holds `CAP_SYS_PTRACE`) is technically accurate and
  matches the exact `EACCES` PIDs I reproduced myself.
- Cleanup: I left no temp files, processes, or capabilities behind from my own verification.

## Verdict

**FINDINGS.** Not a blocking rejection of the spike's own (already conservative) `BLOCKED` conclusion — nothing
here contradicts "do not setcap yet." F1 (MEDIUM) should be closed — by this helper calling `realpath()` on its
target itself, or by an explicit, enforced contract check before the production `ProcessFencePort` adapter ever
invokes this helper with `CAP_SYS_PTRACE` installed — before this prototype is treated as a candidate for real
privilege. F2 (LOW/MEDIUM) is a transparency gap worth closing but does not weaken the fail-closed guarantee.
Everything else independently checked — memory safety, comm parsing, UID domain, path-prefix logic, deleted-suffix
handling, truncation/malformed-link handling, starttime pin/recheck, fixed-point bound, cap detection, exit codes,
no-path-leak output, read-only syscall surface, and build reproducibility — held up under both code reading and
my own independent, reproducible empirical testing.
