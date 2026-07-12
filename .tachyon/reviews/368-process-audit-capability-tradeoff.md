# SDD 368 ProcessAudit helper — residual `(sd-pam)` FD-enumeration capability tradeoff review

Independent security/architecture assessment under journal contract `j-3ea903e0ce8b`, following the real capped
empirical run reported in `j-8cba710cc70e`: accepted binary `a7a756d7` (source `f0172691`, per
`.tachyon/reviews/368-process-audit-helper-r3.md`) executed with `cap_sys_ptrace=yes` on an ext4 (non-`nosuid`)
path, improving the same-UID `EACCES` count from 164 to exactly **one** residual: `eaccess pid=1533 kind=fd`. No
host mutation, capability grant, or source edit was performed for this review — analysis and read-only fact-finding
only.

## Root cause, independently confirmed

```
stat -c '%A %U:%G %n' /proc/1533/fd      → dr-x------ root:root /proc/1533/fd
stat -c '%A %U:%G %n' /proc/1533/limits  → -r--r--r-- root:root /proc/1533/limits
grep -E '^Uid|^Gid' /proc/1533/status    → 1000 1000 1000 1000  (real UID matches us)
cat /proc/1533/comm                      → (sd-pam)
```

PID 1533's real UID is ours, but its `/proc/1533/fd` **directory** is owned by `root` with `dr-x------` (no
group/other bits) — this is the kernel's automatic non-dumpable-process behavior (`prctl(PR_SET_DUMPABLE,0)` or an
equivalent transition, which systemd's PAM session helper sets deliberately to protect session-credential FDs from
inspection, even by the same UID). This is a **different kernel permission gate** than the one guarding `cwd`/
`root`: `readlink(/proc/<pid>/{cwd,root})` on a non-dumpable target is checked via `ptrace_may_access()` — which
`CAP_SYS_PTRACE` bypasses, exactly as the capped run demonstrated (cwd/root became readable). The `fd/` **directory
itself**, however, is gated by plain inode DAC permission bits (`generic_permission()`), a wholly separate code
path that `CAP_SYS_PTRACE` does not touch. That is the entire residual: not a bug, a real, distinct Linux
permission boundary.

**Scope check** (read-only, this host, right now): of 297 currently-running same-UID processes, exactly **one**
(`1533 (sd-pam)`) has a root-owned `fd/` directory; the other 296 are self-owned/readable. So today this is a
narrow, single-PID residual — but it is a **class** (any same-UID process that goes non-dumpable hits the identical
wall), not an intrinsic property of PID 1533 specifically. A production host could plausibly run more than one
(ssh-agent, gpg-agent, and various credential-holding daemons commonly go non-dumpable too).

## Option analysis

### (A) Add `CAP_DAC_READ_SEARCH` alongside `CAP_SYS_PTRACE` — NOT RECOMMENDED

`CAP_DAC_READ_SEARCH` bypasses DAC read **and** search/execute permission checks on **every file and directory on
the system**, not just `/proc`. It would fix the one residual, but it converts a narrowly-scoped "read process
binding metadata via `/proc` symlinks" tool into a tool that can open, list, and read the **contents** of any file
readable-by-root-bypass anywhere on disk — SSH private keys, other users' dotfiles (on a multi-user box), any
config, any credential file. Mode `0700`/user-owned-inode/checksum-pinning mitigate *tampering* with the binary
(nobody else can swap it), but do nothing to shrink what the binary itself can do once invoked — a bug, a supply-
chain compromise of the build step, or a future edit adds a read-arbitrary-file primitive to something that is
supposed to be a narrow `/proc` introspection tool. Blast radius is disproportionate to the one edge case it fixes.
This is exactly the kind of capability creep the review chain (F1/F2/H1/H2 across three prior rounds) has been
deliberately resisting — a broad grant to solve a narrow problem when a narrower mechanism exists (see B). Reject.

### (B) `pidfd_getfd()`-based FD duplication, bounded probe over `RLIMIT_NOFILE` — RECOMMENDED as the next empirical step

`pidfd_getfd(2)`'s own permission model is documented as a `PTRACE_MODE_ATTACH_REALCREDS` check — the **same** gate
that governs `ptrace()` attach and that governs the non-dumpable `cwd`/`root` symlink reads `CAP_SYS_PTRACE` *just
demonstrated it already satisfies* for this exact PID. Critically, `pidfd_getfd` operates on the kernel's internal
per-process file-descriptor table via the `pidfd`, **not** via a procfs directory lookup — so it does not consult
`/proc/<pid>/fd`'s DAC bits at all. In principle this closes the residual using the capability already granted and
already accepted through R1-R3, with no new capability.

**I verified the mechanism directly** (read-only w.r.t. the repo/host; only ephemeral test processes in `/tmp`,
cleaned up): forked a child, had it open a file at an explicit fd number, then from the **parent — holding no
capability at all** — used `pidfd_open()` + a raw `pidfd_getfd` syscall (permitted here only because Yama
`ptrace_scope=1` allows a direct parent to ptrace-attach its own child without `CAP_SYS_PTRACE`, the same class of
exception the existing helper's own design already reasons about). Result: `pidfd_getfd` succeeded, the duplicated
fd resolved via `readlink(/proc/self/fd/<dup>)` to the exact file the child had open, and probing a fd number that
did not exist cleanly failed with `EBADF` — unambiguously distinguishable from success. This confirms the mechanism
and the "probe and catch `EBADF`" pattern both work correctly on this exact kernel. I did **not** test it against an
actual root-owned/non-dumpable target myself, since that requires the capability I was not authorized to (re-)grant
for this review; that specific link — "does `CAP_SYS_PTRACE` also satisfy `pidfd_getfd`'s check against a
non-dumpable same-UID target" — rests on the syscall's documented permission model plus the already-empirically-
confirmed fact that the identical gate already unlocked `cwd`/`root` for this exact PID, not on a direct test.

**Completeness**: `/proc/<pid>/limits` is world-readable (confirmed: `-r--r--r--`) even for the otherwise-locked
`sd-pam`, and its "Max open files" **soft** limit is a real ceiling — a process cannot hold an fd number at or above
its own `RLIMIT_NOFILE`. Probing every candidate number in `[0, soft_limit)` via `pidfd_getfd` and catching `EBADF`
for gaps is therefore a **complete** enumeration for that process, not a best-effort sample — it should return
`empty`/`survivors` rather than a residual `unknown`, closing the class this residual represents, not just this PID.

**Performance/race caveats worth disclosing, not blocking**: the soft limit varies per process — `sd-pam`'s here is
1024 (a fast, bounded probe), but some daemons (and this very audit tooling's own host shell) run with limits in
the hundreds of thousands, which would make a brute-force probe of *that* process slow if it also happened to be
fd-directory-locked; a real implementation should short-circuit to the normal `readdir()` path whenever it works
(the common case — 296/297 here) and only fall back to bounded `pidfd_getfd` probing when `readdir()` specifically
fails with `EACCES` on an otherwise-real, same-UID target. There is a narrow TOCTOU on the limit itself (if a
process raises its own `RLIMIT_NOFILE` between the read and the end of the probe range, a newly-possible high fd
could be missed) — structurally the same class of residual as the already-disclosed target swap/restore window,
not a new category of risk.

### (C) Exclude `sd-pam`/`init.scope` from the audit domain — REJECT

Cannot be independently proven safe, and I looked for a way to justify it rather than assuming the answer.
`(sd-pam)` is a long-lived per-login-session helper that can persist across the session and, in principle, inherit
or hold file descriptors related to that session's credential/PAM state; there is no property of "being sd-pam"
that structurally forbids it from ever holding a `cwd`/`root`/FD binding into an arbitrary directory (it is not a
kernel-enforced invariant, just an assumption about typical behavior). A name/comm-based or path-based carve-out is
exactly the "optimistic audit" class every prior round of this SDD (starting with the very first T0.2 spike)
explicitly forbade — "no inference from display name... permitted," "no fallback... optimistic audit is
acceptable." Excluding a class of process because it is inconvenient to read, rather than because it is provably
incapable of binding the target, reopens precisely the silent-under-report failure mode the whole independent-audit
clause exists to prevent. If a *specific*, *kernel-enforced* argument existed for why non-dumpable service-manager-
spawned helpers structurally cannot hold worktree-path FDs, that would be a different conversation — no such
argument was found, and none should be assumed for the sake of convenience.

### (D) Privileged broker/service — VIABLE LONGER-TERM, NOT NEEDED NOW

A dedicated, minimally-privileged daemon (its own small attack surface, narrow local-socket protocol, peer-
credential-gated) exposing only "read this process's cwd/root/fd-list" is the architecturally cleanest way to keep
a *broad* capability (if one were ever truly required) off of the general-purpose audit binary. It is real added
complexity (process lifecycle, IPC surface, its own review burden) that is not justified **if** option (B) closes
the gap using the capability already accepted — which the evidence above supports. Worth keeping as the fallback
architecture specifically for the case where B is empirically shown insufficient (e.g., some other permission gate
turns out to also block `pidfd_getfd` for a still-undiscovered process class), not as the next step now.

## Recommendation

**Pursue (B) next, empirically, as a scoped follow-up spike** — extend the existing pattern (same host, same
checksum-pinned/hardened-build discipline, same `TEST_ONLY`-seam-style determinism, same no-setcap-without-review
gate) to add a `pidfd_getfd`-based fallback that activates *only* when `readdir()` on a same-UID process's `fd/`
directory fails with `EACCES`, bounded by that process's own readable `RLIMIT_NOFILE` soft limit, falling back to
`unknown` (never `empty`) if the limit itself is unreadable or the probe range is impractically large. This
preserves complete cwd/root/every-FD proof, uses no capability beyond what R1-R3 already justified and what the
human already granted once, and has a meaningfully smaller blast radius than (A). Do **not** add
`CAP_DAC_READ_SEARCH`. Do **not** carve out `sd-pam`/`init.scope` or any other named process class. (D) stays
noted as the fallback architecture if a future host/kernel combination shows (B) insufficient. Production
`proven_empty` / default adapter rollout remains **BLOCKED** regardless of which of these is pursued — this review
recommends a research direction, not a capability grant or an implementation.
