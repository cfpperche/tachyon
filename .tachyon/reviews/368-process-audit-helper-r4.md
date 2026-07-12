# SDD 368 CAP_SYS_PTRACE process-audit helper — Sonnet R4 independent security review — ACCEPT (code) + architecture recommendation

Reviewed candidate `c81256d7be0bfed1565a10557265185a701abeca` (branch `tachyon/processAuditHelperGrokR1`) against
journal contract `j-ff4d252a7bd4`, the R4 correction contract `j-aec448bf6364` (which correctly overturned my own
prior tradeoff-review recommendation to bound the `pidfd_getfd` probe by `RLIMIT_NOFILE`), and my three prior
reports (R1 `fe72ca16`, R2 `c450e11e`, R3 `cba4894c`). Read the full 585-line C source diff, the 111-line test diff,
and the updated report. Canonical `verify_task` ACCEPT, no waiver, `npm run verify:full:quiet` green.

## Part 1 — code review: pidfd fallback implementation (ACCEPT)

**Bound correctness.** `read_stable_nr_open()` reads the global `/proc/sys/fs/nr_open` sysctl — not any per-process
`RLIMIT_NOFILE` — and refuses (`pidfd_nr_open_too_large`) rather than probing when it exceeds the documented
`PIDFD_NR_OPEN_SAFE_MAX` (1,048,576). This correctly implements the coordinator's correction: a process can lower
its own soft (or even hard) `RLIMIT_NOFILE` at any time without the kernel closing already-open fds above the new
limit, so a soft-limit bound is unsound; `nr_open` is a global ceiling no fd can ever exceed regardless of
per-process rlimit games.

**Two-scan convergence.** `scan_fds_via_pidfd()` checks process starttime **and** `nr_open` at three checkpoints
(pre-scan, mid-scan between the two probes, post-scan) and requires the two complete `[0, nr_open)` probes'
occupied-fd evidence (fd number + classification, sorted then compared) to agree **exactly** — any drift at any
checkpoint, or any scan disagreement, fails to a specific `unknown` reason (`identity_drift`,
`pidfd_nr_open_changed`, `pidfd_scan_disagreement`) rather than committing partial evidence.

**Errno handling.** `EBADF` from `pidfd_getfd` is correctly treated as "hole" (fd doesn't exist, continue probing);
every other errno (`ESRCH`, `EPERM`, `EACCES`, `ENOSYS`, `EMFILE`/`ENFILE`, default) maps to a distinct, stable
unknown reason via `pidfd_getfd_fail_reason()` and aborts that process's scan rather than silently skipping.

**Deadline.** A 2-second monotonic-clock deadline is checked on every probe iteration; a full-range probe timing
out fails to `pidfd_deadline`, never truncates silently.

**Allocation/cleanup.** `calloc`'d occupancy buffers (4096 entries × 2) are freed on every one of the ~7 early-
return paths I traced, plus the success path; `pidfd` is closed on every path. I independently compiled the exact
source (`sha256sum` → `427e56d0...`, exact match) and hardened binary (`e84ce9db...`, exact match to the report's
pinned hash), confirmed via `strings` that none of the new `PAH_TEST_*` seam variables leak into the hardened
build, and ran the actual generated test fresh from a clean `/tmp`: passes in <1s, no hang, and leaves only the
same **pre-existing, not-new-to-R4** dangling-symlink cleanup nit I already flagged as non-blocking in R3 (Node
`fs.rmSync` no-ops on an already-dangling symlink; unrelated to the C helper).

**Deterministic high-FD-above-lowered-soft regression.** `test_maybe_spawn_high_fd_child()` (TEST_ONLY only) forks
a child that `dup2`s the target dir to a caller-chosen high fd, then explicitly lowers its own `RLIMIT_NOFILE` soft
limit below that fd number, publishes the lowered value, and blocks — using the same Yama-scope-1 parent/child
ptrace exception this whole review chain has used repeatedly to test capability-gated behavior without needing
`CAP_SYS_PTRACE`. The generated test forces the pidfd path (`PAH_TEST_FORCE_PIDFD_FD_SCAN=1`) with a small
deterministic `nr_open` override (`PAH_TEST_NR_OPEN=512`), spawns a child with `fd=200` after lowering soft to
100, and asserts the fallback finds `match ... fd=200` — concretely, deterministically proving the soft-limit bound
would have missed it (matching the coordinator's correction) while the `nr_open`-bound design does not.

**Report honesty.** Explicitly states, more than once, that on this host `fs.nr_open=2147483584` exceeds
`SAFE_MAX`, so the `sd-pam` residual **still fails closed** as `pidfd_nr_open_too_large` — "honest incompleteness,
not `empty`." I independently reproduced this exact output against my own build:
`unknown reason=pidfd_nr_open_too_large pid=1533 kind=fd` (plus the still-present `eaccess` on cwd/root, since
those go through the ordinary `revalidate`-independent `ptrace_may_access` path, not this fallback). No
`CAP_DAC_READ_SEARCH`, no carve-out, no setcap performed. This part of the candidate is correct and honestly
reported — **accept the code.**

## Part 2 — architecture question: is `pidfd_getfd` enumeration a dead end?

**No — not because `nr_open` is small, but because `nr_open` is the wrong bound to probe at all.** I found and
independently verified a materially better one.

### The answer: `/proc/<pid>/status`'s `FDSize` field

`FDSize` is not a policy value like `RLIMIT_NOFILE` (which a process can freely rewrite downward at any time,
independent of actual fd usage — the exact flaw that sank the soft-limit approach). It reports the kernel's
**current allocated capacity of that process's file-descriptor table** (`files_struct.fdtable.max_fds`). The
kernel can only ever have an open fd at index *N* if the table has already been expanded to hold at least *N+1*
entries — so `FDSize` is a **mechanically kernel-enforced**, monotonically-growing-only upper bound: no open fd for
that process can currently exceed it, by construction, regardless of how the fd got there (`open`, `dup2` to an
explicit high number, `socket`, `pipe`, anything).

I verified all of this empirically, read-only, no capability needed:

- `/proc/1533/status` (the exact locked `sd-pam` PID) is readable **despite** its `fd/` directory being
  `root:root dr-x------` — confirming `status` is not gated by the same non-dumpable/DAC restriction as the `fd/`
  subdirectory (same pattern already established for `/proc/<pid>/limits` in the prior tradeoff review). Its
  `FDSize` right now is **128** — versus `nr_open`'s 2,147,483,584. A probe of `[0, 128)` is trivially fast; a
  probe of `[0, 2147483584)` is not.
- I forked a throwaway child, had it `dup2` a file descriptor to the explicit, non-sequential number 5000, and
  re-read its `/proc/<pid>/status`: `FDSize` correctly jumped to 8192 (the kernel's next table-growth increment
  above 5000) — confirming the bound tracks *any* high fd, not just sequentially-opened ones, and cannot be
  artificially deflated by the process the way `RLIMIT_NOFILE` can.

**This directly answers the architecture question**: probing `[0, FDSize)` via the *already-implemented*
`pidfd_getfd` mechanism (same starttime/two-scan/deadline scaffolding this candidate already built — only the
ceiling source changes, from `nr_open` to `FDSize`, and `FDSize` itself needs the same pre/mid/post drift check
`nr_open` currently gets, since it *can* grow between scans) would very likely close the `sd-pam` residual on this
exact host using **the capability already granted and already accepted through R1–R3** (`CAP_SYS_PTRACE` — the
same gate that already demonstrably unlocked `cwd`/`root` reads for this exact non-dumpable PID in the earlier
capped run) — with **no new capability request at all**. I did not implement or test this against the live
non-dumpable target (would require the capability, outside this review's scope), so I'm not claiming it's proven
sound end-to-end — but the load-bearing claims (readability, correctness, non-spoofability, tight practical size)
are each independently, empirically verified above, not merely asserted.

I recommend the coordinator route a scoped R5: replace (or fall back further from) the `nr_open`-bounded probe with
an `FDSize`-bounded one, before reaching for any new capability. `nr_open` remains a legitimate hard safety ceiling
to reject an implausible/corrupted `FDSize` reading against, not the primary probe bound.

### If `FDSize` turns out insufficient: (i) ephemeral sandboxed `CAP_DAC_READ_SEARCH` helper vs. (ii) minimal broker

Presented in case `FDSize` doesn't pan out (e.g., some pathological process that reports a much larger `FDSize`
than is practical to probe, or a permission wrinkle on `status` I haven't hit on this host) — a comparison based on
documented Linux security architecture, not independently built/tested this round:

**(i) Ephemeral, `CAP_DAC_READ_SEARCH`-holding helper, confined by Landlock + seccomp, with paths pre-opened before
lockdown.** Pattern: a short-lived, separate, checksum-pinned binary (never the general-purpose audit tool)
receives the file capability, immediately `open(O_PATH)`s only the exact `/proc/<pid>/fd` directory (and its own
`/proc/self/fd` for readback) it needs, then installs a Landlock ruleset restricting all further filesystem access
to those already-open descriptors plus a minimal seccomp-bpf allow-list (`openat`, `readlinkat`, `close`, `exit`
— nothing resembling `ptrace`, `write`, `socket`, `execve`), before doing anything else. `CAP_DAC_READ_SEARCH`
bypasses DAC but **not** LSM restrictions — Landlock rules remain fully enforced even though the process nominally
holds a broad capability, so a compromise of this exact short-lived process is confined to the pre-approved paths
and a handful of read-only syscalls, not "read any file on the system." **Authorization implication**: still
requires a second human `setcap` on a second checksum-pinned binary, and the Landlock ruleset itself becomes
safety-critical code needing the same review rigor as everything else in this chain (an under-restrictive ruleset
silently defeats the sandbox; Landlock's ABI has evolved across kernel versions and needs an explicit ABI-version
floor check). Genuinely narrower blast radius than granting `CAP_DAC_READ_SEARCH` unsandboxed to the long-lived
general tool (option A, already rejected in the prior tradeoff review), but it is still a second capability grant
this SDD has not yet needed.

**(ii) Minimal root/capability broker (persistent daemon, narrow protocol).** A single long-lived, heavily-audited
daemon holds the elevated privilege for the process/session lifetime and exposes exactly one operation ("list
cwd/root/fd bindings for PID N") over a Unix socket gated by `SO_PEERCRED` (same UID, expected binary path). Cleaner
separation-of-privilege on paper — the caller never itself holds anything elevated — but trades a bounded, one-shot
privileged execution for a **permanently running** privileged listener, plus new lifecycle (start/stop/crash-
recovery/stale-socket handling) and a new hand-rolled IPC protocol that itself needs security review. For exactly
one narrow operation, this is more standing infrastructure than the problem currently justifies.

**Recommendation if this branch is ever needed**: (i) over (ii). A broker's operational cost only pays for itself
across multiple distinct privileged operations amortized over time; here there is exactly one. An ephemeral,
Landlock+seccomp-confined helper keeps the elevated-privilege window as short as this whole design already
insists everything else be (bounded deadlines, bounded reports, bounded fixed-point passes), and keeps the
capability off of the general-purpose, more-often-invoked audit binary.

## Verdict

**ACCEPT** the R4 code as delivered — correct, honestly reported, thoroughly verified against its own stated
contract (no `RLIMIT_NOFILE`, `nr_open`-bounded, two-scan convergence, proper errno/deadline/cleanup handling,
seam-free hardened build, deterministic capability-free regression proof). **Architecture recommendation**: `pidfd`
enumeration is not a dead end — the candidate correctly identified `nr_open` as an infeasible bound on this host,
but a materially smaller, kernel-enforced, empirically-verified bound (`FDSize` from `/proc/<pid>/status`) is
available under the exact same, already-accepted `CAP_SYS_PTRACE` capability and should be tried before any new
capability grant is considered. If a future host/scenario shows that insufficient, prefer an ephemeral
Landlock+seccomp-confined `CAP_DAC_READ_SEARCH` helper over a persistent broker. Production `proven_empty` /
default adapter rollout remains **BLOCKED** either way, for the already-disclosed target swap/restore residual;
nothing in this review changes that.
