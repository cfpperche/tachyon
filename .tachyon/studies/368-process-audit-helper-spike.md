# SDD 368 — CAP_SYS_PTRACE worktree-binding audit helper feasibility spike

Date: 2026-07-12  
Host: `DESKTOP-BGG95NA`, WSL2  
Investigators: `processAuditHelperGrokR1` (initial spike), `processAuditHelperGrokFixR2` (Sonnet R1 F1/F2 under `j-2cf388e6c4cf`), `processAuditHelperGrokFixR3` (Sonnet R2 H1/H2 correction under `j-df883330e9cf`), `processAuditHelperGrokFixR4` (Grok R4 `pidfd_getfd` fallback under `j-aec448bf6364`)  
Scope: prototype read-only same-UID worktree-binding audit helper under `.tachyon/studies` plus disposable `/tmp` build/install only; no production ProcessFence adapter; no production/tests/config changes except the generated gate test.  
Prior studies: `.tachyon/studies/368-process-fence-spike.md` (audit `EACCES` blocker), `.tachyon/studies/368-process-fence-cgroup-spike.md` (cgroup containment accepted independently).  
Reviews: R1 `fe72ca16` F1/F2; R2 FINDINGS H1 nondeterministic race + H2 per-process swap/restore gap (`.tachyon/reviews/368-process-audit-helper-r2.md`); R3 ACCEPT `cba4894c`; capability tradeoff `j-3ea903e0ce8b` + coordinator correction `j-aec448bf6364`.

## Verdict

**BLOCKED.** The helper prototype is implemented, hardened-compiled, checksum-pinned, and empirically shown to:

1. reproduce the accepted fail-closed result **`unknown`** without capability when same-UID `/proc` targets return `EACCES`;
2. still detect a live open-FD binding to a canonical target while remaining `unknown` because the scan is incomplete;
3. emit only machine-readable state + match pid/starttime/kind/fd evidence + bounded unknown reasons (no unrelated process path strings);
4. refuse to claim a complete no-hit (`empty`) scan on this host without capability;
5. **(F1 closed)** independently `realpath()` the caller target, require **byte-exact** equality with the resolved canonical absolute directory, pin identity via `O_PATH|O_DIRECTORY|O_CLOEXEC` + `fstat` `st_dev`/`st_ino`, and revalidate path+identity before and after every audit pass (symlink alias → refuse; rename/replacement/deletion/identity drift → `unknown`, never silent under-report/`empty`);
6. **(F2 closed)** keep `capability_loss` as a sticky counted/reported unknown reason across fixed-point passes so `state=unknown` cannot print `unknown_count=0`/no reason after an earlier-pass loss observation;
7. **(H1 closed — practical test truth)** expose a **compile-time `TEST_ONLY`** ready/release synchronization seam (absent from the hardened production binary) so the generated gate can **require** the barrier and deterministically force rename/replacement → specific `target_*` unknown, with **no** ambient-`EACCES` race-miss fallback;
8. **(H2 practical close)** revalidate the pinned target and obtain its live `/proc/self/fd` canonical path **around each process/link observation**, compare candidates against that live path, and fail closed with `target_*` on any pre/post path/identity drift (pass-level checks preserved);
9. **(R4 implemented — not host-complete)** on same-UID `/proc/<pid>/fd` `opendir` `EACCES`/`EPERM` only, fall back to raw `pidfd_open` + `pidfd_getfd` probes over **stable `/proc/sys/fs/nr_open`** (documented `PIDFD_NR_OPEN_SAFE_MAX=1048576`), **two complete scans** with starttime + nr_open pre/mid/post identity checks, monotonic deadline, exact occupied-evidence agreement (FD number + classification); **never** uses `RLIMIT_NOFILE` soft/hard as a completeness bound. `EBADF` = absence; `ESRCH`/`EPERM`/`EACCES`/`ENOSYS`/`EMFILE`/other → explicit unknown. On this host `fs.nr_open=2147483584` exceeds the safe maximum, so the residual `sd-pam` class still fails closed as `pidfd_nr_open_too_large` (honest incompleteness, not `empty`).

However, installing the authorized **file capability** `CAP_SYS_PTRACE` requires interactive credentials on this host:

- `sudo -n true` → `sudo: interactive authentication is required` (exit 1)
- `sudo -n setcap cap_sys_ptrace=ep <binary>` → same failure
- unprivileged `setcap` → `unable to set CAP_SETFCAP effective capability: Operation not permitted`

Per the spike contract: **do not claim feasibility** of a complete privileged audit when capability install is not already noninteractive. **No setcap was performed in this R4 round.** No `CAP_DAC_READ_SEARCH`. This is **not** a PASS and **not** authorization to ship a production ProcessFence adapter or to treat `proven_empty` / default sequential handoff as closed.

### Irreducible residual (must stay explicit)

A **malicious same-UID** actor that coordinates **move+restore entirely between separate procfs syscalls** (inside the pre-observation revalidate → `readlink` → post-observation revalidate window, or any other multi-syscall gap) **cannot be mathematically excluded** by this `readlink`/`stat` primitive. Per-observation checks close practical accidental races and force fail-closed on held drift; they do **not** prove an atomic cross-process binding observation. **BLOCK production `proven_empty` / default adapter rollout** until the threat model is explicitly re-ratified or a stronger inode/subtree primitive is proven. Swap/restore characterization is covered in the gate test and leaves host incompleteness (`unknown`) without claiming `empty`.

## Contract under test

Accepted ProcessFence independent-audit predicate (unchanged):

| Result | Meaning |
|---|---|
| `empty` | complete no-hit scan of the declared domain |
| `survivors` | one or more matching cwd/root/FD bindings and no incomplete evidence |
| `unknown` | any unreadable / unstable / truncated / malformed / identity-drift / capability-loss evidence |

Helper requirements exercised:

- scan only processes whose **real UID** equals the invoker’s real UID;
- accept one **canonical absolute** directory target and **independently verify** it (`realpath` byte-exact match + `O_PATH` pin + every-pass pre/post revalidation + **per-observation** revalidation);
- never signal, ptrace-attach, write procfs, mutate the target, or expose unrelated process paths;
- inspect `cwd`, `root`, and every FD via `readlink` only (excluding the helper’s own target pin FD);
- strip a single trailing ` (deleted)` display suffix carefully for binding paths; treat pin-FD `(deleted)` as fail-closed target drift;
- pin and recheck `/proc/<pid>/stat` starttime around the per-pid scan;
- rescan vanishing processes to a bounded fixed point (max 8 passes);
- sticky `capability_loss` reason survives pass resets when observed;
- stable machine-readable stdout; exit `0 empty | 1 survivors | 2 unknown | 3 error`;
- compile with hardening flags; record source and **hardened** binary SHA-256;
- `TEST_ONLY` seam is compile-time guarded and **absent** from the hardened binary proposed for capability;
- test first without capability; attempt file capability only if `sudo -n` / setcap is noninteractive;
- never solicit, capture, cache, or bypass a password;
- remove any installed/temp binary after experiments and prove cleanup.

## Host facts (2026-07-12)

| Fact | Value |
|---|---|
| Kernel | `Linux 6.6.114.1-microsoft-standard-WSL2` x86_64 |
| Distro | Ubuntu (same host class as prior 368 spikes) |
| Virt | WSL2 (`DESKTOP-BGG95NA`) |
| UID | `1000:1000` (`goat`); effective capabilities empty |
| Yama | `ptrace_scope = 1` |
| `/proc` options | `rw,nosuid,nodev,noexec,noatime` (no `hidepid`) |
| Seccomp (investigator shell) | mode 2 + filter present; `NoNewPrivs=0` |
| CapBnd | includes CAP_SYS_PTRACE bit (bounding set allows file-cap raise if authorized) |
| `sudo -n` | fails: interactive authentication required |
| Same-UID `EACCES` sample | PID `1530` `systemd`, `1533` `(sd-pam)`, `1193083` `postgrest` |

## Artifacts

| Artifact | Path / value |
|---|---|
| Source | `.tachyon/studies/368-process-audit-helper.c` |
| Source SHA-256 | `427e56d0c5556197d9241d747dfe8df31c9baf0deed9b563c14201929bd30d5a` |
| Binary SHA-256 (hardened, seam-free) | `e84ce9db1ccb648714e0526522a4525419fc1069a926f5423040d882bdae318f` |
| TEST_ONLY binary | built only in the generated gate (`-DTEST_ONLY`); **not** capability candidate; different hash |
| Disposable build root | `/tmp/tachyon-368-audit-build-*` (removed after experiments) |
| Disposable targets | `/tmp/tachyon-368-audit-target-*` (removed after experiments) |
| Correction journals | R2 `j-2cf388e6c4cf`; R3 `j-df883330e9cf`; R4 `j-aec448bf6364` on task `t-0b5723` |
| R1 / R2 / R3 reviews | `.tachyon/reviews/368-process-audit-helper-r1.md`, `…-r2.md`, `…-r3.md` |
| Capability tradeoff | `.tachyon/reviews/368-process-audit-capability-tradeoff.md` (soft-limit premise **superseded** by `j-aec448bf6364`) |

## Build (exact)

Hardened production build (checksum-pinned; **no** `-DTEST_ONLY`):

```bash
BUILDDIR=$(mktemp -d -p /tmp tachyon-368-audit-build-XXXXXX)
gcc -O2 -pipe \
  -Wall -Wextra -Werror \
  -fstack-protector-strong \
  -D_FORTIFY_SOURCE=2 \
  -fPIE -pie \
  -Wl,-z,relro,-z,now \
  -o "$BUILDDIR/process-audit-helper" \
  .tachyon/studies/368-process-audit-helper.c
sha256sum .tachyon/studies/368-process-audit-helper.c "$BUILDDIR/process-audit-helper"
# strings must NOT contain PAH_TEST_SEAM_DIR
```

TEST_ONLY build (gate barriers only; never propose for setcap):

```bash
gcc -O2 -pipe -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
  -fPIE -pie -Wl,-z,relro,-z,now -DTEST_ONLY \
  -o "$BUILDDIR/process-audit-helper-test" \
  .tachyon/studies/368-process-audit-helper.c
```

Observed:

```text
compile_ok
427e56d0c5556197d9241d747dfe8df31c9baf0deed9b563c14201929bd30d5a  .tachyon/studies/368-process-audit-helper.c
e84ce9db1ccb648714e0526522a4525419fc1069a926f5423040d882bdae318f  .../process-audit-helper
ELF 64-bit LSB pie executable, x86-64, dynamically linked
readelf: FLAGS BIND_NOW; FLAGS_1 NOW PIE
hardened strings: no PAH_TEST_SEAM_DIR / PAH_TEST_FORCE_PIDFD / PAH_TEST_SPAWN_HIGH_FD / PAH_TEST_NR_OPEN
```

Hardening notes: PIE + full RELRO (`-Wl,-z,relro,-z,now`) + stack protector + FORTIFY. The binary is a spike prototype, not a production install target.

## Helper semantics (prototype)

Machine-readable lines (stable keys):

```text
state=empty|survivors|unknown
self_ruid=<uid>
target=<canonical-absolute-dir>
cap_sys_ptrace=yes|no
match_count=<n>
unknown_count=<n>
match pid=<pid> starttime=<ticks> kind=cwd|root
match pid=<pid> starttime=<ticks> kind=fd fd=<n>
unknown reason=<code> [pid=<pid>] [kind=...] [fd=<n>]
```

Unknown reason codes used: `eaccess`, `truncation`, `malformed_link`, `read_error`, `status_unreadable`, `stat_unreadable`, `fd_dir_error`, `identity_drift`, `capability_loss`, `proc_unreadable`, `pid_enum_truncated`, `instability_fixed_point`, `target_missing`, `target_path_drift`, `target_identity_drift`, `target_deleted`, `target_not_dir`, `target_fd_error`, plus R4 pidfd reasons: `pidfd_nr_open_unreadable`, `pidfd_nr_open_too_large`, `pidfd_nr_open_changed`, `pidfd_deadline`, `pidfd_scan_disagreement`, `pidfd_occupied_overflow`, `pidfd_oom`, `pidfd_open_enosys`, `pidfd_open_eperm`, `pidfd_open_emfile`, `pidfd_open_error`, `pidfd_getfd_esrch`, `pidfd_getfd_eperm`, `pidfd_getfd_eacces`, `pidfd_getfd_enosys`, `pidfd_getfd_emfile`, `pidfd_getfd_error`.

Pre-scan refuse codes on stderr (exit 3): `error=target_not_absolute`, `error=target_not_canonical` (includes symlink alias where `realpath` ≠ input), `error=target_trailing_slash`, `error=target_unresolvable`, `error=target_open_failed`, `error=target_too_long`.

Report lists are bounded (`match` ≤ 256, `unknown` ≤ 64) with `*_truncated=yes omitted=N` when capped; counts remain total. Target revalidation failures use a critical report slot so TOCTOU reasons remain visible even when the EACCES report is saturated. Unrelated process path strings are never printed (only the caller-supplied `target=`).

State precedence implemented (fail-closed):

1. any incomplete evidence → `unknown` (exit 2);
2. else any match → `survivors` (exit 1);
3. else → `empty` (exit 0).

Matches may still be listed under `unknown` so an operator can see detected bindings without treating the scan as complete.

### Target pin + revalidation (F1 + H2 practical)

1. Syntactic checks (absolute, no `/./` `/../`, no trailing slash).
2. `realpath(target)` must succeed and equal the caller string **byte-for-byte** (symlink components → `error=target_not_canonical`, exit 3).
3. `open(target, O_PATH|O_DIRECTORY|O_CLOEXEC)`; `fstat` pins `st_dev`+`st_ino`.
4. Before and after **every** fixed-point pass: re-`realpath` + path `stat` + O_PATH `fstat` + `readlink(/proc/self/fd/<pin>)` must match the pinned path and identity; `(deleted)` suffix on the pin FD → `target_deleted`.
5. **Around each process/link observation:** revalidate and capture the pin’s **live** `/proc/self/fd` path; compare the process link candidate against that live path; revalidate again after the observation. Any pre/post path or identity drift → `target_*` unknown (sticky fail-closed; never under-report as `empty`).
6. The helper’s own pin FD is excluded from FD match enumeration so the pin is not reported as a binding.

### TEST_ONLY synchronization seam (H1)

Compiled only with `-DTEST_ONLY` (not in the hardened capability candidate):

| Env | Role |
|---|---|
| `PAH_TEST_SEAM_DIR` | directory for `<phase>.ready` / `<phase>.release` markers |
| `PAH_TEST_SEAM_PHASE` | exact phase to arm: `post_pin` or `obs` (others no-op) |

Phases:

- `post_pin` — immediately after successful initial pin (and recheck after release);
- `obs` — once at the first per-link observation (recheck after release before continuing).

The generated gate **requires** the ready marker, forces rename/replacement under parent control, and asserts a specific `target_*` reason. There is **no** `if (attacked) … else ambient eaccess` fallback.

### Sticky capability_loss (F2)

Per-pass counters reset each fixed-point iteration, but `saw_cap_loss` is sticky. Once set (started with effective CAP_SYS_PTRACE and later `capget` shows it gone), every subsequent pass re-adds `unknown reason=capability_loss` so the final printed output cannot be `state=unknown` with `unknown_count=0` and no reason line.

### R4 pidfd_getfd fallback (`j-aec448bf6364`)

**Trigger (production):** only when same-UID `/proc/<pid>/fd` `opendir` fails with `EACCES` or `EPERM`. Normal readable `readdir` path is unchanged.

**Completeness bound (critical correction):** **`/proc/sys/fs/nr_open`**, not `RLIMIT_NOFILE` soft/hard. A process may retain already-open FDs above a subsequently lowered soft (or hard) limit — probing `[0, soft)` is **incomplete** and must not be implemented. Coordinator superseded the tradeoff review’s soft-limit premise.

**Algorithm:**

1. Read stable `fs.nr_open`. Unreadable → `pidfd_nr_open_unreadable`. Value `0` or `> PIDFD_NR_OPEN_SAFE_MAX` (documented **1048576**) → `pidfd_nr_open_too_large`.
2. `pidfd_open(pid, 0)`; pin `/proc/<pid>/stat` starttime; close every pidfd/dup on all paths.
3. Monotonic deadline (`PIDFD_SCAN_DEADLINE_MS=2000`) for the whole two-scan of that process.
4. **Scan A:** for each candidate FD in `[0, nr_open)`, `pidfd_getfd`; `EBADF` = hole (absence); success → `readlink(/proc/self/fd/<dup>)` classify bind/nobind/nonpath/trunc/error, **always close dup**; any other errno → explicit unknown and abort that process.
5. Recheck starttime + nr_open (change → `identity_drift` / `pidfd_nr_open_changed`).
6. **Scan B:** identical probe; occupied evidence (FD number + classification) must **agree exactly** with scan A or → `pidfd_scan_disagreement`.
7. Commit agreed `FD_CLS_BIND` as matches; classification errors as unknowns.

**Not used:** `CAP_DAC_READ_SEARCH`, process-name carve-outs, soft/hard `RLIMIT_NOFILE` as probe ceiling.

**TEST_ONLY seams (absent from hardened binary):**

| Env | Role |
|---|---|
| `PAH_TEST_FORCE_PIDFD_FD_SCAN=1` | force pidfd path even when readdir would work (parent/child regressions) |
| `PAH_TEST_NR_OPEN=<n>` | override probe ceiling (≤ SAFE_MAX) for bounded tests |
| `PAH_TEST_SPAWN_HIGH_FD=<n>` | helper forks a child that opens the target at FD `n`, then lowers soft `RLIMIT_NOFILE` below `n` |

**Host facts (R4):**

| Fact | Value |
|---|---|
| `fs.nr_open` | `2147483584` (exceeds SAFE_MAX → production fallback refuse-closed) |
| Yama `ptrace_scope` | `1` |
| `pidfd_getfd` without CAP_SYS_PTRACE | works for parent→dumpable child; `EPERM` for non-descendant / non-dumpable |
| Real capped residual (prior) | `eaccess pid=1533 kind=fd` for root-owned `(sd-pam)` fd dir |

**Performance (TEST_ONLY forced two-scan + high-FD child, this host):**

| `PAH_TEST_NR_OPEN` | Wall ms (representative) | high FD=200 found |
|---|---|---|
| 512 | ~104 | yes |
| 1024 | ~153 | yes |
| 4096 | ~462 | yes |

Full host ceiling `2147483584` is not probed (SAFE_MAX refuse). A complete 1 048 576×2 probe of a single permitted process is on the order of ~1 s of pure `pidfd_getfd` syscalls on this kernel class; production only enters the fallback on `EACCES` fd dirs (rare).

## Experiment 1 — without capability, no intended binding

```bash
TARGET=$(mktemp -d -p /tmp tachyon-368-audit-target-XXXXXX)
"$BUILDDIR/process-audit-helper" "$TARGET"; echo exit=$?
```

Observed (representative):

```text
state=unknown
self_ruid=1000
target=/tmp/tachyon-368-audit-target-…
cap_sys_ptrace=no
match_count=0
unknown_count=…
unknown reason=eaccess pid=… kind=cwd
…
exit=2
```

**No `empty` result** without capability. Path-leak check: no absolute paths in stdout other than the supplied `target=`.

## Experiment 2 — without capability, live open-FD binding

Disposable writer (cwd `/`, open FD to `$TARGET/writer.log`) still surfaces as `match kind=fd` while overall state remains **`unknown`** due to ambient same-UID `EACCES`. The helper’s own O_PATH pin is not counted as a match.

## Experiment 3 — F1 symlink target rejection

Symlink aliases that are not already the byte-exact resolved path are **refused** before scan (`error=target_not_canonical`, exit 3).

## Experiment 4 — H1 deterministic post_pin rename/replacement (TEST_ONLY)

```text
PAH_TEST_SEAM_DIR=… PAH_TEST_SEAM_PHASE=post_pin ./process-audit-helper-test $TARGET
# parent waits for post_pin.ready, rename+mkdir replacement, touch post_pin.release
→ state=unknown
→ unknown reason=target_identity_drift
→ exit=2
```

Barrier **must** be reached; ambient `eaccess` alone is not accepted as proof.

## Experiment 5 — H2 hold drift across observation (TEST_ONLY)

```text
PAH_TEST_SEAM_PHASE=obs … 
# parent waits for obs.ready, rename+mkdir held across observation, release
→ state=unknown
→ unknown reason=target_identity_drift (or other target_*)
→ exit=2
```

## Experiment 6 — swap/restore characterization (TEST_ONLY)

At `obs.ready`, rename target away then restore the **same inode** before release. Post-barrier revalidate can see a restored path and continue; host still ends `unknown` from ambient `EACCES`, not a complete `empty`. This characterizes the **malicious same-UID move+restore residual** between separate procfs syscalls — still **not** closed by this primitive. **BLOCK production proven_empty / adapter rollout.**

## Experiment 7 — file capability install (noninteractive only)

```bash
sudo -n true
# => exit 1; stderr: sudo: interactive authentication is required

sudo -n /usr/sbin/setcap cap_sys_ptrace=ep "$BUILDDIR/process-audit-helper"
# => exit 1; same interactive authentication failure

/usr/sbin/setcap cap_sys_ptrace=ep "$BUILDDIR/process-audit-helper"
# => exit 1; unable to set CAP_SETFCAP effective capability: Operation not permitted

getcap "$BUILDDIR/process-audit-helper"
# => no capabilities
```

No password was solicited, captured, cached, or bypassed. **Capability-enabled scan was not executed.** Feasibility of a complete `empty`/`survivors` result under `CAP_SYS_PTRACE` on this host is therefore **not demonstrated**.

### One minimal human residual (not run in R4)

After rebuilding the **hardened** binary and verifying SHA-256 `e84ce9db1ccb648714e0526522a4525419fc1069a926f5423040d882bdae318f`, a human with credentials could install `cap_sys_ptrace=ep` on that exact binary (on a non-`nosuid` filesystem) for a privileged recheck of whether `pidfd_getfd` closes the `sd-pam` residual when `fs.nr_open` is also within SAFE_MAX or is lowered. That step is **out of band**, was **not** performed in this R4 worker round, and still does **not** erase the irreducible move+restore residual or authorize production rollout.

## Experiment 8 — R4 high-FD above lowered soft limit (TEST_ONLY)

```bash
PAH_TEST_FORCE_PIDFD_FD_SCAN=1 PAH_TEST_NR_OPEN=512 PAH_TEST_SPAWN_HIGH_FD=200 \
  ./process-audit-helper-test "$TARGET"
# → match kind=fd fd=200 for the helper-spawned child
# → soft RLIMIT_NOFILE was lowered to 100 (= high/2); soft-bound [0, soft) would MISS 200
# → ambient non-child pidfd attempts → pidfd_getfd_eperm (explicit unknown)
# → child reaped; /tmp/pah-test-soft-<pid> removed
```

**Proves:** stable-`nr_open` / pidfd path finds FDs that a soft-`RLIMIT_NOFILE` completeness bound would miss. Soft-limit premise is empirically unsound.

## Experiment 9 — production EACCES fd-dir → nr_open too large (this host)

Without capability, PID 1533 `(sd-pam)` still yields cwd/root `eaccess`; fd-directory `EACCES` now routes through the pidfd fallback and reports `pidfd_nr_open_too_large` because host `fs.nr_open=2147483584` exceeds documented SAFE_MAX `1048576`. State remains **`unknown`** (never `empty`).

## Security analysis

| Topic | Analysis |
|---|---|
| Privilege model | Intended privilege is **file capability** `CAP_SYS_PTRACE` only (ep), not setuid-root. |
| Least privilege | Helper is read-only: `readlink`/`open`/`read` on `/proc` plus `O_PATH` on the target, no `ptrace(PTRACE_ATTACH)`, no signals, no procfs writes, no target mutation. |
| Output surface | Does not print foreign path strings — only state, counts, match pid/starttime/kind/fd, and bounded unknown reason codes. |
| Domain limit | Real-UID filter: other users’ processes are skipped silently. |
| Target canonicality (F1) | Independent `realpath` + byte-exact match + `O_PATH` pin + every-pass pre/post revalidation. |
| Per-observation drift (H2 practical) | Live `/proc/self/fd` path + pre/post revalidate around each link observation; held rename → `target_*` unknown. |
| Irreducible residual | Malicious same-UID **move+restore between separate procfs syscalls** cannot be mathematically excluded by this readlink primitive. |
| Identity races (pid) | Starttime pin + recheck around each pid scan; drift → `identity_drift` unknown. |
| Truncation | `readlink` buffer fill → `truncation` unknown. PID enum overflow → `pid_enum_truncated` unknown. |
| Capability loss (F2) | Sticky `capability_loss` re-counted/reported every pass through final output. |
| TEST_ONLY seam | Present only in `-DTEST_ONLY` builds; hardened binary strings contain no `PAH_TEST_SEAM_DIR`; no environment-controlled pause in the privileged candidate. |
| Attack surface if cap installed | Broader same-UID `/proc` read — sensitive; binary must be tightly owned, checksum-verified before setcap. |
| What this does **not** prove | Production adapter correctness, atomic binding observation under a coordinating attacker, or that `CAP_SYS_PTRACE` is the final architecture choice. |
| Relation to cgroup spike | Cgroup containment can prove membership empty; this audit is the **independent** worktree-binding clause. Neither alone is full `proven_empty`. |

## Cleanup proof

After experiments:

```bash
rm -rf /tmp/tachyon-368-audit-build-* /tmp/tachyon-368-audit-target-*
find /tmp -maxdepth 1 -name 'tachyon-368-audit*' -print
# no output — CLEAN
```

No file capabilities were successfully installed, so no `setcap -r` was required. No system config was modified. No production tree paths outside owned spike files and the generated gate test were changed.

## Residuals

| Residual | Severity | Notes |
|---|---|---|
| Interactive credentials required for `setcap` | **Blocks feasibility claim** | Noninteractive setcap unavailable on this host |
| Capability-enabled complete scan not observed in R4 | Blocks PASS | Prior capped run (R3 binary) reduced 164→1 residual; R4 binary not re-capped here |
| Host `fs.nr_open` > SAFE_MAX | Blocks host-complete FD enum | `2147483584` → `pidfd_nr_open_too_large` for EACCES fd dirs |
| Malicious same-UID move+restore between procfs syscalls | **Irreducible with this primitive** | Disclosed; **BLOCK production proven_empty / adapter** |
| Production ProcessFence adapter | Out of scope / blocked | Explicit non-goal; still unavailable |
| Cap + seccomp interaction under agent runtimes | Residual risk | Re-verify CapEff after exec of any capped binary |
| Independent re-review | Planned | Sonnet re-reviews R4; coordinator retains acceptance |

## Findings status

| Finding | Severity | Status |
|---|---|---|
| F1 target canonicality / TOCTOU | MEDIUM | **Closed** (R2) — realpath + O_PATH + pass revalidation |
| F2 sticky cap-loss reason transparency | LOW/MEDIUM | **Closed** (R2) — sticky re-emit every pass |
| H1 nondeterministic bare race / EACCES fallback | MEDIUM | **Closed** (R3) — TEST_ONLY seam; barrier required; forced `target_*` |
| H2 per-process swap/restore window | HIGH (practical) / residual | **Practical fail-closed** via per-observation checks; **fundamental residual remains** and is disclosed; production still **BLOCKED** |
| R4 soft-limit completeness (tradeoff B) | HIGH (correctness) | **Rejected** — do not use `RLIMIT_NOFILE`; use stable `fs.nr_open` + two-scan (`j-aec448bf6364`) |
| R4 `pidfd_getfd` fallback | — | **Implemented** under contract; host still **BLOCKED** (nr_open too large + no setcap in R4 + move+restore residual) |

## What this does and does not authorize

**Does:**

- land a minimal, hardened, checksum-pinned **prototype** helper source under `.tachyon/studies`;
- close H1 test nondeterminism and practical per-observation drift handling under `j-df883330e9cf` without overclaiming the fundamental procfs race;
- implement R4 `pidfd_getfd` fallback under stable `fs.nr_open` + two-scan convergence (`j-aec448bf6364`), with high-FD soft-bound-miss regression;
- document that without capability the host still fails closed at `unknown` for the global same-UID audit;
- keep the malicious same-UID swap/restore residual explicit.

**Does not:**

- claim CAP_SYS_PTRACE audit feasibility (BLOCKED);
- claim production `proven_empty` or default ProcessFence adapter readiness (BLOCKED);
- install a durable privileged binary or `CAP_DAC_READ_SEARCH`;
- implement or enable a production `ProcessFencePort` adapter;
- erase the irreducible multi-syscall move+restore residual;
- claim host-complete FD enumeration while `fs.nr_open` exceeds SAFE_MAX.

## Reproducible no-cap assertion (always)

```text
1. hardened build of pinned source succeeds; strings have no PAH_TEST_* seams
2. without cap: state=unknown exit=2 on empty disposable target
3. EACCES / pidfd_* unknowns include systemd / (sd-pam) class; sd-pam fd → pidfd_nr_open_too_large on this host
4. open-FD writer to target appears as match kind=fd while state remains unknown
5. symlink target path refused (exit 3 error=target_not_canonical)
6. TEST_ONLY post_pin barrier + forced rename → specific target_* (no EACCES fallback)
7. TEST_ONLY obs barrier + held rename → specific target_*
8. swap/restore characterization keeps residual disclosed; no empty claim
9. TEST_ONLY high-FD=200 after soft-limit lowering found via pidfd; soft-bound would miss
10. noninteractive setcap unavailable => BLOCKED feasibility; no setcap performed in R4
11. /tmp tachyon-368-audit-* build/target trees and pah-test-soft-* removed
```
